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

export const startTime = Date.now()
