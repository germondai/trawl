import { ProxyPool } from "@trawl/tiers"

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
export const PORT = Number(process.env.PORT ?? "8191")
export const POOL_SIZE = Number(process.env.BROWSER_POOL_SIZE ?? "3")
// How long acquire() will poll for a free browser before rejecting with PoolExhaustedError.
// 15s covers a full CF challenge burst with pool=3 (queue depth 7, slowest finishes at ~12s).
// Tune lower for fast-fail feedback in dev; tune higher for very heavy upstream targets.
export const ACQUIRE_TIMEOUT_MS = Number(process.env.BROWSER_ACQUIRE_TIMEOUT_MS ?? "15000")
export const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS ?? "3600")
export const RECYCLE_AFTER_TEMPORARY_CONTEXTS = Number(process.env.BROWSER_RECYCLE_AFTER_CONTEXTS ?? "8")
// Caps Firefox content processes per browser. Default `2` keeps thread/RAM footprint
// minimal while still allowing CF/Imperva challenges to resolve. Raise if specific
// targets fail with empty content (rare).
export const CONTENT_PROCESSES = Number(process.env.BROWSER_CONTENT_PROCESSES ?? "2")

// PROXY_URL / RESIDENTIAL_PROXY_URL accept a comma-separated list of proxy URLs (a single
// URL still works — it's just a 1-element list). *_LIST_FILE is an alternative source
// (one proxy per line) for lists too large for a single env var.
export const proxyPool =
  ProxyPool.fromEnv(process.env.PROXY_URL || undefined, process.env.PROXY_LIST_FILE || undefined) ?? undefined
export const residentialProxyPool =
  ProxyPool.fromEnv(
    process.env.RESIDENTIAL_PROXY_URL || undefined,
    process.env.RESIDENTIAL_PROXY_LIST_FILE || undefined,
  ) ?? undefined

// ── MITM forward-proxy mode ────────────────────────────────────────────────────
// Optional browser-backed HTTP(S) forward proxy (apps/api/src/proxy). Off by default.
// When enabled, point a client's HTTP(S) proxy at MITM_PROXY_PORT and every request is
// re-issued through the browser pool — for clients that only consume cookies+UA from
// /v1 and re-fetch themselves, which fails on fingerprint-bound Cloudflare clearances.
// See proxy/server.ts for the full rationale.
export const MITM_PROXY_ENABLED = /^(1|true|yes)$/i.test(process.env.MITM_PROXY_ENABLED ?? "")
export const MITM_PROXY_PORT = Number(process.env.MITM_PROXY_PORT ?? "8192")
// Default 0.0.0.0 — the dominant deployment is docker-compose (clients reach trawl
// through the docker bridge, which requires a non-loopback bind). Loopback-only
// operators can set MITM_PROXY_HOST=127.0.0.1. The primary safety guard remains
// MITM_PROXY_ENABLED=false.
export const MITM_PROXY_HOST = process.env.MITM_PROXY_HOST ?? "0.0.0.0"
// CA cert + key live here (persist across restarts so the CA is installed once).
export const MITM_PROXY_CA_DIR = process.env.MITM_PROXY_CA_DIR ?? "/data/proxy-ca"
// Cap the tier the proxy will escalate to (e.g. keep it off residential Tier 4).
export const MITM_PROXY_MAX_TIER = process.env.MITM_PROXY_MAX_TIER
  ? (Number(process.env.MITM_PROXY_MAX_TIER) as 1 | 2 | 3 | 4)
  : undefined
// Log one line per proxied request (method, url, status, content-type, bytes). Off by
// default — proxied clients can be chatty. Errors are always logged.
export const MITM_PROXY_DEBUG = /^(1|true|yes)$/i.test(process.env.MITM_PROXY_DEBUG ?? "")

export const startTime = Date.now()
