import { BrowserPool, MemorySessionCache, SessionCache } from "@trawl/browser"
import type { AcquireOptions, OrchestratorDeps } from "@trawl/tiers"
import type { SessionData } from "@trawl/types"
import {
  ACQUIRE_TIMEOUT_MS,
  BROWSER_MAX_CONTENT_PROCESSES,
  CLOSE_TIMEOUT_MS,
  HEADFUL_POOL_SIZE,
  LAUNCH_TIMEOUT_MS,
  POOL_SIZE,
  proxyPool,
  RECYCLE_AFTER_TEMPORARY_CONTEXTS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_RETRY_DELAY_MS,
  REDIS_SESSION_TTL_SECONDS,
  REDIS_URL,
  residentialProxyPool,
  SESSION_CACHE_DRIVER,
  STALL_TIMEOUT_MS,
} from "./config"

const state: {
  pool?: BrowserPool
  headfulPool?: BrowserPool
} = {}

const handleOwners = new WeakMap<object, BrowserPool>()

type BrowserPoolOptions = ConstructorParameters<typeof BrowserPool>[0]

interface SessionCacheClient {
  connect(timeoutMs?: number): Promise<void>
  close(): void
  load(domain: string): Promise<SessionData | undefined>
  save(domain: string, data: SessionData): Promise<void>
  invalidate(domain: string): Promise<void>
}

interface SessionCacheRecoveryOptions {
  createCache: () => SessionCacheClient
  connectTimeoutMs: number
  retryDelayMs: number
  onConnected?: () => void
  onUnavailable?: (error: unknown) => void
}

export class SessionCacheRecovery {
  private cache?: SessionCacheClient
  private retryTimer?: ReturnType<typeof setTimeout>
  private stopped = true

  constructor(private readonly options: SessionCacheRecoveryOptions) {}

  current(): SessionCacheClient | undefined {
    return this.cache
  }

  async start(): Promise<void> {
    await this.stop()
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.cache?.close()
    this.cache = undefined
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const candidate = this.options.createCache()
    try {
      await candidate.connect(this.options.connectTimeoutMs)
      if (this.stopped) {
        candidate.close()
        return
      }
      this.cache = candidate
      this.options.onConnected?.()
    } catch (error) {
      candidate.close()
      if (this.stopped) return
      this.options.onUnavailable?.(error)
      if (this.options.retryDelayMs === 0) return
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        void this.connect()
      }, this.options.retryDelayMs)
      this.retryTimer.unref?.()
    }
  }
}

const redisUrl = REDIS_URL
const sessionCacheRecovery = SESSION_CACHE_DRIVER === "memory"
  ? new SessionCacheRecovery({
      createCache: () => new MemorySessionCache({ ttlSeconds: REDIS_SESSION_TTL_SECONDS }),
      connectTimeoutMs: 0,
      retryDelayMs: 0,
      onConnected: () => console.log("[api] session cache: memory  (Tier 2 fast-path enabled, per-instance)"),
    })
  : redisUrl
    ? new SessionCacheRecovery({
        createCache: () => new SessionCache({ redisUrl, ttlSeconds: REDIS_SESSION_TTL_SECONDS }),
        connectTimeoutMs: REDIS_CONNECT_TIMEOUT_MS,
        retryDelayMs: REDIS_RETRY_DELAY_MS,
        onConnected: () => console.log("[api] session cache connected  (Tier 2 fast-path enabled)"),
        onUnavailable: (err) => {
          const retry = REDIS_RETRY_DELAY_MS > 0 ? `; retrying in ${REDIS_RETRY_DELAY_MS}ms` : ""
          console.warn(
            `[api] session cache unavailable — Tier 2 disabled${retry}:`,
            err instanceof Error ? err.message : err,
          )
        },
      })
    : undefined

interface InitPoolOptions {
  poolSize?: number
  headfulPoolSize?: number
  createPool?: (options: BrowserPoolOptions) => BrowserPool
  initCache?: () => Promise<void>
}

export const getPool = () => state.pool
export const getHeadfulPool = () => state.headfulPool

const initSessionCache = (): Promise<void> => sessionCacheRecovery?.start() ?? Promise.resolve()

export const shutdownPools = async (): Promise<void> => {
  await Promise.all([sessionCacheRecovery?.stop(), state.pool?.shutdown(), state.headfulPool?.shutdown()])
}

export const initPool = async ({
  poolSize = POOL_SIZE,
  headfulPoolSize = HEADFUL_POOL_SIZE,
  createPool = (options) => new BrowserPool(options),
  initCache = initSessionCache,
}: InitPoolOptions = {}): Promise<void> => {
  const pool = createPool({
    poolSize,
    acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
    contentProcesses: BROWSER_MAX_CONTENT_PROCESSES,
    stallAfterMs: STALL_TIMEOUT_MS,
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
    launchTimeoutMs: LAUNCH_TIMEOUT_MS,
  })

  state.headfulPool = undefined
  if (headfulPoolSize > 0) {
    state.headfulPool = createPool({
      poolSize: headfulPoolSize,
      acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
      recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
      contentProcesses: BROWSER_MAX_CONTENT_PROCESSES,
      virtualDisplay: true,
      label: "pool:headful",
      stallAfterMs: STALL_TIMEOUT_MS,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      launchTimeoutMs: LAUNCH_TIMEOUT_MS,
    })
  }
  // Publish the pool before its first await. Tier 1 can serve immediately and
  // browser-backed requests can wait in acquire() while capacity warms.
  state.pool = pool

  try {
    await Promise.all([initCache(), pool.init()])
    pool.startHealthCheck()
    if (state.headfulPool) {
      await state.headfulPool.init()
      state.headfulPool.startHealthCheck()
      console.log(`[api] headful pool warm (${headfulPoolSize} browser${headfulPoolSize === 1 ? "" : "s"})`)
    }
  } catch (error) {
    await Promise.all([pool.shutdown(), state.headfulPool?.shutdown()])
    throw error
  }

  console.log(`[api] ready — all ${poolSize} browser${poolSize === 1 ? "" : "s"} warm`)
}

export const getDeps = (): OrchestratorDeps => {
  if (!state.pool) throw new Error("pool not ready")
  const p = state.pool
  return {
    acquireBrowser: async (d: string, budgetMs?: number, options?: AcquireOptions) => {
      if (options?.headful) {
        const headful = state.headfulPool
        if (!headful) throw new Error("DataDome requires BROWSER_HEADFUL_POOL_SIZE greater than 0")
        const handle = await headful.acquire(d, budgetMs)
        handleOwners.set(handle, headful)
        return handle
      }
      const handle = await p.acquire(d, budgetMs)
      handleOwners.set(handle, p)
      return handle
    },
    releaseBrowser: (handle) => {
      handleOwners.get(handle)?.release(handle.id, handle.lease)
      handleOwners.delete(handle)
    },
    loadSession: (d: string) =>
      sessionCacheRecovery
        ?.current()
        ?.load(d)
        .catch(() => undefined) ?? Promise.resolve(undefined),
    saveSession: (d: string, data: SessionData) =>
      sessionCacheRecovery
        ?.current()
        ?.save(d, data)
        .catch(() => {}) ?? Promise.resolve(),
    invalidateSession: (d: string) =>
      sessionCacheRecovery
        ?.current()
        ?.invalidate(d)
        .catch(() => {}) ?? Promise.resolve(),
    proxyPool,
    residentialProxyPool,
  }
}
