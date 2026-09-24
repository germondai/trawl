import { describe, expect, test } from "bun:test"

type ConfigSnapshot = {
  redisUrl: string | null
  sessionCacheDriver: string
  redisSessionTtlSeconds: number
  memorySessionCacheMaxEntries: number
  poolSize: number
  maxContentProcesses: number
  acquireTimeoutMs: number
  recycleAfterContexts: number
  headfulPoolSize: number
  scrapeMinTier: number
  scrapeProxySelection: string
  stallTimeoutMs: number
  closeTimeoutMs: number
  launchTimeoutMs: number
  port: number
  mitmPort: number
}

const readConfig = (overrides: Record<string, string>): ConfigSnapshot => {
  const script = `
    const config = await import("./config.ts")
    console.log(JSON.stringify({
      redisUrl: config.REDIS_URL ?? null,
      sessionCacheDriver: config.SESSION_CACHE_DRIVER,
      redisSessionTtlSeconds: config.REDIS_SESSION_TTL_SECONDS,
      memorySessionCacheMaxEntries: config.MEMORY_SESSION_CACHE_MAX_ENTRIES,
      poolSize: config.POOL_SIZE,
      maxContentProcesses: config.BROWSER_MAX_CONTENT_PROCESSES,
      acquireTimeoutMs: config.ACQUIRE_TIMEOUT_MS,
      recycleAfterContexts: config.RECYCLE_AFTER_TEMPORARY_CONTEXTS,
      headfulPoolSize: config.HEADFUL_POOL_SIZE,
      scrapeMinTier: config.SCRAPE_MIN_TIER,
      scrapeProxySelection: config.SCRAPE_PROXY_SELECTION,
      stallTimeoutMs: config.STALL_TIMEOUT_MS,
      closeTimeoutMs: config.CLOSE_TIMEOUT_MS,
      launchTimeoutMs: config.LAUNCH_TIMEOUT_MS,
      port: config.PORT,
      mitmPort: config.MITM_PORT,
    }))
  `
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: import.meta.dir,
    env: { ...process.env, ...overrides },
  })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as ConfigSnapshot
}

describe("environment configuration", () => {
  test("reads the renamed variables and trims REDIS_URL", () => {
    expect(
      readConfig({
        REDIS_URL: "  redis://cache.test:6379/2  ",
        SESSION_CACHE_DRIVER: " MeMoRy ",
        REDIS_SESSION_TTL_SECONDS: "7200",
        MEMORY_SESSION_CACHE_MAX_ENTRIES: "250",
        BROWSER_POOL_SIZE: "4",
        BROWSER_MAX_CONTENT_PROCESSES: "3",
        BROWSER_ACQUIRE_TIMEOUT_MS: "12000",
        BROWSER_RECYCLE_AFTER_CONTEXTS: "0",
        BROWSER_HEADFUL_POOL_SIZE: "2",
        SCRAPE_MIN_TIER: "3",
        SCRAPE_PROXY_SELECTION: " RoUnDrObIn ",
        BROWSER_STALL_TIMEOUT_MS: "90000",
        BROWSER_CLOSE_TIMEOUT_MS: "8000",
        BROWSER_LAUNCH_TIMEOUT_MS: "45000",
        PORT: "9000",
        MITM_PORT: "9001",
      }),
    ).toEqual({
      redisUrl: "redis://cache.test:6379/2",
      sessionCacheDriver: "memory",
      redisSessionTtlSeconds: 7200,
      memorySessionCacheMaxEntries: 250,
      poolSize: 4,
      maxContentProcesses: 3,
      acquireTimeoutMs: 12000,
      recycleAfterContexts: 0,
      headfulPoolSize: 2,
      scrapeMinTier: 3,
      scrapeProxySelection: "roundrobin",
      stallTimeoutMs: 90000,
      closeTimeoutMs: 8000,
      launchTimeoutMs: 45000,
      port: 9000,
      mitmPort: 9001,
    })
  })

  test("disables Redis for a blank URL and safely rejects malformed numeric values", () => {
    expect(
      readConfig({
        REDIS_URL: "   ",
        SESSION_CACHE_DRIVER: "",
        REDIS_SESSION_TTL_SECONDS: "-1",
        MEMORY_SESSION_CACHE_MAX_ENTRIES: "0",
        SESSION_TTL_SECONDS: "99",
        BROWSER_POOL_SIZE: "NaN",
        BROWSER_MAX_CONTENT_PROCESSES: "0",
        BROWSER_CONTENT_PROCESSES: "99",
        BROWSER_ACQUIRE_TIMEOUT_MS: "-5",
        BROWSER_RECYCLE_AFTER_CONTEXTS: "-1",
        BROWSER_HEADFUL_POOL_SIZE: "1.5",
        SCRAPE_MIN_TIER: "",
        SCRAPE_PROXY_SELECTION: "",
        BROWSER_STALL_TIMEOUT_MS: "Infinity",
        BROWSER_CLOSE_TIMEOUT_MS: "0",
        BROWSER_LAUNCH_TIMEOUT_MS: "unsafe",
        PORT: "70000",
        MITM_PORT: "0",
      }),
    ).toEqual({
      redisUrl: null,
      sessionCacheDriver: "redis",
      redisSessionTtlSeconds: 3600,
      memorySessionCacheMaxEntries: 1000,
      poolSize: 1,
      maxContentProcesses: 2,
      acquireTimeoutMs: 15000,
      recycleAfterContexts: 8,
      headfulPoolSize: 0,
      scrapeMinTier: 1,
      scrapeProxySelection: "failover",
      stallTimeoutMs: 180000,
      closeTimeoutMs: 10000,
      launchTimeoutMs: 90000,
      port: 8191,
      mitmPort: 8192,
    })
  })

  test("rejects an unknown session cache driver", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'await import("./config.ts")'],
      cwd: import.meta.dir,
      env: { ...process.env, SESSION_CACHE_DRIVER: "memroy" },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Invalid SESSION_CACHE_DRIVER "memroy"')
  })

  test("rejects an invalid scrape tier floor instead of silently using Tier 1", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'await import("./config.ts")'],
      cwd: import.meta.dir,
      env: { ...process.env, SCRAPE_MIN_TIER: "browser" },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Invalid SCRAPE_MIN_TIER "browser"; expected 1, 2, 3, or 4')
  })

  test("rejects an unknown proxy selection policy", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'await import("./config.ts")'],
      cwd: import.meta.dir,
      env: { ...process.env, SCRAPE_PROXY_SELECTION: "rotate" },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(
      'Invalid SCRAPE_PROXY_SELECTION "rotate"; expected "failover", "roundrobin", or "random"',
    )
  })
})
