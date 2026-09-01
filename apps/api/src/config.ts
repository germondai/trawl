import { ProxyPool } from "@trawl/tiers"

export const REDIS_URL = process.env.REDIS_URL?.trim() || undefined
// Session cache driver: "redis" (default, shared across instances) or
// "memory" (in-process Map, zero dependencies, per-instance only).
export const SESSION_CACHE_DRIVER = (process.env.SESSION_CACHE_DRIVER ?? "redis").toLowerCase() as "redis" | "memory"
const integerInRange = (value: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}
const positiveInteger = (value: string | undefined, fallback: number): number => integerInRange(value, fallback, 1)
const nonNegativeInteger = (value: string | undefined, fallback: number): number => integerInRange(value, fallback, 0)

export const PORT = integerInRange(process.env.PORT, 8_191, 1, 65_535)
export const POOL_SIZE = positiveInteger(process.env.BROWSER_POOL_SIZE, 3)
// How long acquire() will poll for a free browser before rejecting with PoolExhaustedError.
// 15s covers a full CF challenge burst with pool=3 (queue depth 7, slowest finishes at ~12s).
// Tune lower for fast-fail feedback in dev; tune higher for very heavy upstream targets.
export const ACQUIRE_TIMEOUT_MS = positiveInteger(process.env.BROWSER_ACQUIRE_TIMEOUT_MS, 15_000)
export const REDIS_SESSION_TTL_SECONDS = positiveInteger(process.env.REDIS_SESSION_TTL_SECONDS, 3_600)
// A failed initial Redis connection must not disable Tier 2 for the process lifetime.
// Each attempt is bounded; failed attempts are retried in the background while the API stays ready.
export const REDIS_CONNECT_TIMEOUT_MS = positiveInteger(process.env.REDIS_CONNECT_TIMEOUT_MS, 5_000)
export const REDIS_RETRY_DELAY_MS = nonNegativeInteger(process.env.REDIS_RETRY_DELAY_MS, 5_000)
// Rolling-replace a browser after this many Tier 3/4 temporary contexts. Every
// creation counts regardless of outcome; 0 disables periodic replacement.
export const RECYCLE_AFTER_TEMPORARY_CONTEXTS = nonNegativeInteger(process.env.BROWSER_RECYCLE_AFTER_CONTEXTS, 8)
// Caps Firefox content processes per browser. Default `2` keeps thread/RAM footprint
// minimal while still allowing CF/Imperva challenges to resolve. Raise if specific
// targets fail with empty content (rare).
export const BROWSER_MAX_CONTENT_PROCESSES = positiveInteger(process.env.BROWSER_MAX_CONTENT_PROCESSES, 2)
// Size of the headful sub-pool, launched behind Xvfb for DataDome Device Check escalations.
//
// Off by default because this pool sits ON TOP of BROWSER_POOL_SIZE: one headful browser
// plus its X display measures ~380 MB, which would silently move the memory ceiling of a
// deployment that never meets DataDome. Set it to 1 to scrape DataDome targets.
export const HEADFUL_POOL_SIZE = nonNegativeInteger(process.env.BROWSER_HEADFUL_POOL_SIZE, 0)

// Optional MCP Streamable HTTP endpoint. Keep this disabled unless the API is
// reachable only by trusted clients; v1 intentionally has no authentication.
export const MCP_ENABLED = /^(1|true|yes)$/i.test(process.env.MCP_ENABLED ?? "")
export const MCP_ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

// How long a browser may stay checked out before the pool calls it wedged rather than
// busy. A scrape's own budget is req.maxTimeout (default 60s), so 3x that is well clear
// of anything legitimate while still catching a hung checkout within a few minutes.
export const STALL_TIMEOUT_MS = positiveInteger(process.env.BROWSER_STALL_TIMEOUT_MS, 180_000)
// Upper bound on a single browser/context close during a recycle. Camoufox can hang on
// close when a content process is wedged; past this we abandon the close and relaunch.
export const CLOSE_TIMEOUT_MS = positiveInteger(process.env.BROWSER_CLOSE_TIMEOUT_MS, 10_000)
// Upper bound on a browser launch. A cold Camoufox start is a few seconds, but launches
// have been observed to hang indefinitely — without a bound that strands the pool entry.
export const LAUNCH_TIMEOUT_MS = positiveInteger(process.env.BROWSER_LAUNCH_TIMEOUT_MS, 90_000)

// PROXY_URL / RESIDENTIAL_PROXY_URL accept a comma-separated list of proxy URLs (a single
// URL still works — it's just a 1-element list). *_LIST_FILE is an alternative source
// (one proxy per line) for lists too large for a single env var.
export const proxyPool = ProxyPool.fromEnv(process.env.PROXY_URL, process.env.PROXY_LIST_FILE)
export const residentialProxyPool = ProxyPool.fromEnv(
  process.env.RESIDENTIAL_PROXY_URL,
  process.env.RESIDENTIAL_PROXY_LIST_FILE,
)

// ── MITM forward-proxy mode ────────────────────────────────────────────────────
// Optional browser-backed HTTP(S) forward proxy (apps/api/src/proxy). Off by default.
// When enabled, point a client's HTTP(S) proxy at MITM_PORT and every request is
// re-issued through the browser pool — for clients that only consume cookies+UA from
// /v1 and re-fetch themselves, which fails on fingerprint-bound Cloudflare clearances.
// See proxy/server.ts for the full rationale.
export const MITM_ENABLED = /^(1|true|yes)$/i.test(process.env.MITM_ENABLED ?? "")
export const MITM_PORT = integerInRange(process.env.MITM_PORT, 8_192, 1, 65_535)
// Default 0.0.0.0 — the dominant deployment is docker-compose (clients reach trawl
// through the docker bridge, which requires a non-loopback bind). Loopback-only
// operators can set MITM_HOST=127.0.0.1. The primary safety guard remains
// MITM_ENABLED=false.
export const MITM_HOST = process.env.MITM_HOST ?? "0.0.0.0"
// CA cert + key live here (persist across restarts so the CA is installed once).
export const MITM_CA_DIR = process.env.MITM_CA_DIR ?? "/data/proxy-ca"
// Cap the tier the proxy will escalate to (e.g. keep it off residential Tier 4).
const configuredMaxTier = Number(process.env.MITM_MAX_TIER)
const isTier = (tier: number): tier is 1 | 2 | 3 | 4 => tier === 1 || tier === 2 || tier === 3 || tier === 4
export const MITM_MAX_TIER = isTier(configuredMaxTier) ? configuredMaxTier : undefined
// Skip the proxy's direct Tier 0 probe and route ordinary HTTP requests into scrape().
// This is separate from ScrapeRequest.skipHttp, which controls scraper Tier 1.
export const MITM_ALWAYS_SCRAPE = /^(1|true|yes)$/i.test(process.env.MITM_ALWAYS_SCRAPE ?? "")
// Log one line per proxied request (method, url, status, content-type, bytes). Off by
// default — proxied clients can be chatty. Errors are always logged.
export const MITM_DEBUG = /^(1|true|yes)$/i.test(process.env.MITM_DEBUG ?? "")

export const startTime = Date.now()
