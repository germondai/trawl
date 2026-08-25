import { BrowserPool, SessionCache } from "@trawl/browser"
import type { AcquireOptions, OrchestratorDeps } from "@trawl/tiers"
import type { SessionData } from "@trawl/types"
import {
  ACQUIRE_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  CONTENT_PROCESSES,
  HEADFUL_POOL_SIZE,
  LAUNCH_TIMEOUT_MS,
  POOL_SIZE,
  proxyPool,
  RECYCLE_AFTER_TEMPORARY_CONTEXTS,
  REDIS_URL,
  residentialProxyPool,
  SESSION_TTL,
  STALL_TIMEOUT_MS,
} from "./config"

// Keeps the two pools' browser ids disjoint, so releaseBrowser() can route a handle back
// to the pool that issued it.
const HEADFUL_ID_OFFSET = 1000

const state: {
  pool?: BrowserPool
  headfulPool?: BrowserPool
  headfulReady?: Promise<void>
  sessionCache?: SessionCache
} = {}

export const getPool = () => state.pool
export const getHeadfulPool = () => state.headfulPool

// Warmed on the first DataDome escalation rather than at startup: a deployment that never
// meets DataDome should not pay for an idle browser and its X display, and readiness must
// not wait on a pool most requests never touch. The first such request pays the cold start.
const warmHeadfulPool = async (): Promise<BrowserPool | undefined> => {
  const pool = state.headfulPool
  if (!pool) return undefined
  if (!state.headfulReady) {
    state.headfulReady = pool.init().then(() => {
      pool.startHealthCheck()
      console.log(`[api] headful pool warm (${HEADFUL_POOL_SIZE} browser${HEADFUL_POOL_SIZE === 1 ? "" : "s"})`)
    })
    // Let a later request retry the launch instead of caching the failure forever.
    state.headfulReady.catch(() => {
      state.headfulReady = undefined
    })
  }
  try {
    await state.headfulReady
    return pool
  } catch (err) {
    console.warn(
      "[api] headful pool unavailable, falling back to the headless pool:",
      err instanceof Error ? err.message : err,
    )
    return undefined
  }
}

const initSessionCache = async (): Promise<void> => {
  try {
    const sessionCache = new SessionCache({
      redisUrl: REDIS_URL,
      ttlSeconds: SESSION_TTL,
    })
    await sessionCache.connect()
    state.sessionCache = sessionCache
    console.log("[api] session cache connected  (Tier 2 fast-path enabled)")
  } catch (err) {
    state.sessionCache = undefined
    console.warn("[api] session cache unavailable — Tier 2 disabled:", err instanceof Error ? err.message : err)
  }
}

export const initPool = async (): Promise<void> => {
  const pool = new BrowserPool({
    poolSize: POOL_SIZE,
    acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
    contentProcesses: CONTENT_PROCESSES,
    stallAfterMs: STALL_TIMEOUT_MS,
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
    launchTimeoutMs: LAUNCH_TIMEOUT_MS,
  })

  if (HEADFUL_POOL_SIZE > 0) {
    state.headfulPool = new BrowserPool({
      poolSize: HEADFUL_POOL_SIZE,
      acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
      recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
      contentProcesses: CONTENT_PROCESSES,
      virtualDisplay: true,
      idOffset: HEADFUL_ID_OFFSET,
      label: "pool:headful",
      stallAfterMs: STALL_TIMEOUT_MS,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      launchTimeoutMs: LAUNCH_TIMEOUT_MS,
    })
  }
  // Publish the pool before its first await. Tier 1 can serve immediately and
  // browser-backed requests can wait in acquire() while capacity warms.
  state.pool = pool

  await Promise.all([initSessionCache(), pool.init()])
  pool.startHealthCheck()

  console.log(`[api] ready — all ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"} warm`)
}

export const getDeps = (): OrchestratorDeps => {
  if (!state.pool) throw new Error("pool not ready")
  const p = state.pool
  return {
    acquireBrowser: async (d: string, budgetMs?: number, options?: AcquireOptions) => {
      if (options?.headful) {
        const headful = await warmHeadfulPool()
        if (headful) return headful.acquire(d, budgetMs)
      }
      return p.acquire(d, budgetMs)
    },
    releaseBrowser: (id: number, lease?: number) => {
      if (id >= HEADFUL_ID_OFFSET) state.headfulPool?.release(id, lease)
      else p.release(id, lease)
    },
    loadSession: (d: string) =>
      state.sessionCache ? state.sessionCache.load(d).catch(() => undefined) : Promise.resolve(undefined),
    saveSession: (d: string, data: SessionData) =>
      state.sessionCache ? state.sessionCache.save(d, data).catch(() => {}) : Promise.resolve(),
    invalidateSession: (d: string) =>
      state.sessionCache ? state.sessionCache.invalidate(d).catch(() => {}) : Promise.resolve(),
    proxyPool,
    residentialProxyPool,
  }
}
