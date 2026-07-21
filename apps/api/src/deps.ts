import { BrowserPool, SessionCache } from "@trawl/browser"
import {
  ACQUIRE_TIMEOUT_MS,
  CONTENT_PROCESSES,
  POOL_SIZE,
  proxyPool,
  RECYCLE_AFTER_TEMPORARY_CONTEXTS,
  REDIS_URL,
  residentialProxyPool,
  SESSION_TTL,
  STALL_TIMEOUT_MS,
} from "./config"

// Single embedded pool — no BullMQ / worker process required.
// Redis is optional: without it, session caching (Tier 2 fast path) is disabled
// but scraping still works via Tier 1 / Tier 3.
let pool: BrowserPool | null = null
let sessionCache: SessionCache | null = null

export function getPool(): BrowserPool | null {
  return pool
}

export async function initPool() {
  try {
    sessionCache = new SessionCache({
      redisUrl: REDIS_URL,
      ttlSeconds: SESSION_TTL,
    })
    console.log("[api] session cache connected  (Tier 2 fast-path enabled)")
  } catch (err) {
    console.warn("[api] session cache unavailable — Tier 2 disabled:", err instanceof Error ? err.message : err)
  }

  pool = new BrowserPool({
    poolSize: POOL_SIZE,
    acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
    contentProcesses: CONTENT_PROCESSES,
    stallAfterMs: STALL_TIMEOUT_MS,
  })
  await pool.init()
  pool.startHealthCheck()
  console.log(`[api] ready — all ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"} warm`)
}

export function getDeps() {
  if (!pool) throw new Error("pool not ready")
  const p = pool
  const sc = sessionCache
  return {
    acquireBrowser: (d: string) => p.acquire(d),
    releaseBrowser: (id: number) => p.release(id),
    // Session cache ops are no-ops when Redis is unavailable
    loadSession: (d: string) => (sc ? sc.load(d).catch(() => null) : Promise.resolve(null)),
    saveSession: (d: string, data: unknown) => (sc ? sc.save(d, data as never).catch(() => {}) : Promise.resolve()),
    invalidateSession: (d: string) => (sc ? sc.invalidate(d).catch(() => {}) : Promise.resolve()),
    proxyPool,
    residentialProxyPool,
  }
}
