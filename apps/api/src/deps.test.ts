import { describe, expect, test } from "bun:test"
import { BrowserPool } from "@trawl/browser"
import type { BrowserHandle } from "@trawl/types"
import { SCRAPE_MAX_TIMEOUT_MS, SCRAPE_MIN_TIER } from "./config"
import {
  createSessionCacheRecovery,
  getDeps,
  getHeadfulPool,
  getPool,
  initPool,
  SessionCacheRecovery,
  shutdownPools,
} from "./deps"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const handle = (headful: boolean): BrowserHandle => ({
  id: 0,
  lease: headful ? 2 : 1,
  headful,
  context: {},
  browser: {},
  fingerprint: { userAgent: "test", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
})

function poolFactory(options: { failHeadful?: boolean } = {}) {
  const pools: Array<{
    headful: boolean
    events: string[]
    releases: Array<[number, number | undefined]>
    pool: BrowserPool
  }> = []
  const createPool = (config: ConstructorParameters<typeof BrowserPool>[0]): BrowserPool => {
    const headful = config.virtualDisplay === true
    const record = { headful, events: [] as string[], releases: [] as Array<[number, number | undefined]> }
    const pool = {
      init: async () => {
        record.events.push("init")
        if (headful && options.failHeadful) throw new Error("xvfb launch failed")
      },
      startHealthCheck: () => record.events.push("health"),
      shutdown: async () => record.events.push("shutdown"),
      acquire: async () => handle(headful),
      release: (id: number, lease?: number) => record.releases.push([id, lease]),
      getStats: () => ({ total: 1, busy: 0, available: 1, restarts: 0, avgRestarts: 0, stalled: 0, live: 1 }),
    } as unknown as BrowserPool
    pools.push({ ...record, pool })
    return pool
  }
  return { pools, createPool }
}

describe("browser pool dependencies", () => {
  test("cold boot defers both pools and routes first requests to their owner", async () => {
    let launches = 0
    await initPool({
      poolSize: 1,
      headfulPoolSize: 1,
      coldBoot: true,
      initCache: async () => {},
      createPool: (options) =>
        new BrowserPool({
          ...options,
          browserFactory: async () => {
            launches++
            return {
              browser: { isConnected: () => true, close: async () => {} },
              context: { pages: () => [], close: async () => {} },
            }
          },
        }),
    })
    try {
      expect(launches).toBe(0)
      expect(getPool()?.getStats()).toMatchObject({ live: 0, sleeping: 1 })
      expect(getHeadfulPool()?.getStats()).toMatchObject({ live: 0, sleeping: 1 })
      const deps = getDeps()
      const handles = await Promise.all([
        deps.acquireBrowser("example.test", 500),
        deps.acquireBrowser("example.test", 500, { headful: true }),
      ])
      expect(launches).toBe(2)
      expect(handles.map((handle) => handle.headful)).toEqual([false, true])
      for (const handle of handles) deps.releaseBrowser(handle)
      expect(getPool()?.getStats().available).toBe(1)
      expect(getHeadfulPool()?.getStats().available).toBe(1)
    } finally {
      await shutdownPools()
    }
  })

  test("disabled headful configuration starts only the main pool and fails headful acquisition clearly", async () => {
    const factory = poolFactory()
    await initPool({ poolSize: 1, headfulPoolSize: 0, createPool: factory.createPool, initCache: async () => {} })

    expect(factory.pools).toHaveLength(1)
    expect(factory.pools[0]?.events).toEqual(["init", "health"])
    expect(getHeadfulPool()).toBeUndefined()
    await expect(getDeps().acquireBrowser("example.test", 100, { headful: true })).rejects.toThrow(
      "BROWSER_HEADFUL_POOL_SIZE greater than 0",
    )
    await shutdownPools()
  })

  test("starts and shuts down both pools and returns equal-id handles to their owner", async () => {
    const factory = poolFactory()
    await initPool({ poolSize: 1, headfulPoolSize: 1, createPool: factory.createPool, initCache: async () => {} })
    const deps = getDeps()
    expect(deps.minTier).toBe(SCRAPE_MIN_TIER)
    expect(deps.defaultMaxTimeout).toBe(SCRAPE_MAX_TIMEOUT_MS)
    const headless = await deps.acquireBrowser("example.test", 100, { headful: false })
    const headful = await deps.acquireBrowser("example.test", 100, { headful: true })

    expect(headless.id).toBe(headful.id)
    deps.releaseBrowser(headless)
    deps.releaseBrowser(headful)
    expect(factory.pools[0]?.releases).toEqual([[0, 1]])
    expect(factory.pools[1]?.releases).toEqual([[0, 2]])

    await shutdownPools()
    expect(factory.pools[0]?.events).toEqual(["init", "health", "shutdown"])
    expect(factory.pools[1]?.events).toEqual(["init", "health", "shutdown"])
  })

  test("a headful launch failure closes both pools and rejects startup", async () => {
    const factory = poolFactory({ failHeadful: true })
    await expect(
      initPool({ poolSize: 1, headfulPoolSize: 1, createPool: factory.createPool, initCache: async () => {} }),
    ).rejects.toThrow("xvfb launch failed")
    expect(factory.pools[0]?.events).toEqual(["init", "health", "shutdown"])
    expect(factory.pools[1]?.events).toEqual(["init", "shutdown"])
  })
})

describe("session cache recovery", () => {
  test("creates a working memory cache without a Redis URL", async () => {
    const recovery = createSessionCacheRecovery({
      driver: "memory",
      ttlSeconds: 60,
      memoryMaxEntries: 1,
      redisConnectTimeoutMs: 10,
      redisRetryDelayMs: 10,
    })
    expect(recovery).toBeDefined()
    await recovery?.start()

    const data = { cookies: [], userAgent: "test", savedAt: Date.now() }
    await recovery?.current()?.save("first.test", data)
    await recovery?.current()?.save("second.test", data)
    expect(await recovery?.current()?.load("first.test")).toBeUndefined()
    expect(await recovery?.current()?.load("second.test")).toEqual(data)

    await recovery?.stop()
    expect(recovery?.current()).toBeUndefined()
  })

  test("keeps Redis cache disabled when the default driver has no URL", () => {
    expect(
      createSessionCacheRecovery({
        driver: "redis",
        ttlSeconds: 60,
        memoryMaxEntries: 100,
        redisConnectTimeoutMs: 10,
        redisRetryDelayMs: 10,
      }),
    ).toBeUndefined()
  })

  test("enables the cache after a failed initial connection without restarting", async () => {
    let attempts = 0
    const closed: number[] = []
    const connected: number[] = []
    const recovery = new SessionCacheRecovery({
      createCache: () => {
        const id = ++attempts
        return {
          connect: async () => {
            if (id === 1) throw new Error("redis still starting")
          },
          close: () => closed.push(id),
          load: async () => undefined,
          save: async () => {},
          invalidate: async () => {},
        }
      },
      connectTimeoutMs: 10,
      retryDelayMs: 5,
      onConnected: () => connected.push(attempts),
    })

    await recovery.start()
    expect(recovery.current()).toBeUndefined()
    await sleep(15)

    expect(attempts).toBe(2)
    expect(closed).toEqual([1])
    expect(connected).toEqual([2])
    expect(recovery.current()).toBeDefined()

    await recovery.stop()
    expect(closed).toEqual([1, 2])
  })

  test("cancels a pending retry during shutdown", async () => {
    let attempts = 0
    const recovery = new SessionCacheRecovery({
      createCache: () => ({
        connect: async () => {
          attempts++
          throw new Error("offline")
        },
        close: () => {},
        load: async () => undefined,
        save: async () => {},
        invalidate: async () => {},
      }),
      connectTimeoutMs: 10,
      retryDelayMs: 10,
    })

    await recovery.start()
    await recovery.stop()
    await sleep(20)

    expect(attempts).toBe(1)
    expect(recovery.current()).toBeUndefined()
  })

  test("supports intentionally cacheless deployments without a retry loop", async () => {
    let attempts = 0
    const recovery = new SessionCacheRecovery({
      createCache: () => ({
        connect: async () => {
          attempts++
          throw new Error("disabled")
        },
        close: () => {},
        load: async () => undefined,
        save: async () => {},
        invalidate: async () => {},
      }),
      connectTimeoutMs: 10,
      retryDelayMs: 0,
    })

    await recovery.start()
    await sleep(15)

    expect(attempts).toBe(1)
    await recovery.stop()
  })
})
