import { describe, expect, test } from "bun:test"

type ConfigSnapshot = {
  userPrefs: Record<string, string | number | boolean>
  redisUrl: string | null
  sessionCacheDriver: string
  redisSessionTtlSeconds: number
  memorySessionCacheMaxEntries: number
  poolSize: number
  maxContentProcesses: number
  hardwareConcurrency: number | null
  acquireTimeoutMs: number
  recycleAfterContexts: number
  headfulPoolSize: number
  scrapeMinTier: number
  scrapeMaxTimeoutMs: number
  scrapeProxySelection: string
  stallTimeoutMs: number
  closeTimeoutMs: number
  shutdownDrainMs: number
  launchTimeoutMs: number
  port: number
  mitmPort: number
  mitmEscalate429: boolean
}

const readConfig = (overrides: Record<string, string>): ConfigSnapshot => {
  const script = `
    const config = await import("./config.ts")
    console.log(JSON.stringify({
      redisUrl: config.REDIS_URL ?? null,
      userPrefs: config.USER_PREFS,
      sessionCacheDriver: config.SESSION_CACHE_DRIVER,
      redisSessionTtlSeconds: config.REDIS_SESSION_TTL_SECONDS,
      memorySessionCacheMaxEntries: config.MEMORY_SESSION_CACHE_MAX_ENTRIES,
      poolSize: config.POOL_SIZE,
      maxContentProcesses: config.BROWSER_MAX_CONTENT_PROCESSES,
      hardwareConcurrency: config.BROWSER_HARDWARE_CONCURRENCY ?? null,
      acquireTimeoutMs: config.ACQUIRE_TIMEOUT_MS,
      recycleAfterContexts: config.RECYCLE_AFTER_TEMPORARY_CONTEXTS,
      headfulPoolSize: config.HEADFUL_POOL_SIZE,
      scrapeMinTier: config.SCRAPE_MIN_TIER,
      scrapeMaxTimeoutMs: config.SCRAPE_MAX_TIMEOUT_MS,
      scrapeProxySelection: config.SCRAPE_PROXY_SELECTION,
      stallTimeoutMs: config.STALL_TIMEOUT_MS,
      closeTimeoutMs: config.CLOSE_TIMEOUT_MS,
      shutdownDrainMs: config.SHUTDOWN_DRAIN_MS,
      launchTimeoutMs: config.LAUNCH_TIMEOUT_MS,
      port: config.PORT,
      mitmPort: config.MITM_PORT,
      mitmEscalate429: config.MITM_ESCALATE_429,
    }))
  `
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      MITM_ESCALATE_429: "",
      BROWSER_HARDWARE_CONCURRENCY: "",
      USER_PREFS: "",
      SCRAPE_MAX_TIMEOUT_MS: "",
      BROWSER_SHUTDOWN_DRAIN_MS: "",
      ...overrides,
    },
  })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as ConfigSnapshot
}

describe("environment configuration", () => {
  test("bounds shutdown drain to leave room for the forced-exit timer", () => {
    expect(readConfig({}).shutdownDrainMs).toBe(0)
    expect(readConfig({ BROWSER_SHUTDOWN_DRAIN_MS: "240000" }).shutdownDrainMs).toBe(240000)
    expect(readConfig({ BROWSER_SHUTDOWN_DRAIN_MS: "2147453647" }).shutdownDrainMs).toBe(2147453647)
    for (const value of ["2147453648", "-1", "1.5", "NaN"]) {
      expect(readConfig({ BROWSER_SHUTDOWN_DRAIN_MS: value }).shutdownDrainMs).toBe(0)
    }
  })

  test("reads the deployment-wide default scrape timeout", () => {
    expect(readConfig({ SCRAPE_MAX_TIMEOUT_MS: " 120000 " }).scrapeMaxTimeoutMs).toBe(120000)
    expect(readConfig({}).scrapeMaxTimeoutMs).toBe(60000)
  })

  test.each(["0", "-1", "1.5", "NaN", "2147483648"])("rejects invalid global scrape timeout %s", (value) => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'await import("./config.ts")'],
      cwd: import.meta.dir,
      env: { ...process.env, SCRAPE_MAX_TIMEOUT_MS: value },
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("SCRAPE_MAX_TIMEOUT_MS must be an integer from 1 to 2147483647")
  })

  test.each(["", "false", "0", "invalid"])("keeps 429 escalation disabled for %s", (value) => {
    expect(readConfig({ MITM_ESCALATE_429: value }).mitmEscalate429).toBe(false)
  })
  test.each(["true", "TRUE", "1", "yes"])("enables 429 escalation for %s", (value) => {
    expect(readConfig({ MITM_ESCALATE_429: value }).mitmEscalate429).toBe(true)
  })

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
      userPrefs: {},
      redisUrl: "redis://cache.test:6379/2",
      sessionCacheDriver: "memory",
      redisSessionTtlSeconds: 7200,
      memorySessionCacheMaxEntries: 250,
      poolSize: 4,
      maxContentProcesses: 3,
      hardwareConcurrency: null,
      acquireTimeoutMs: 12000,
      recycleAfterContexts: 0,
      headfulPoolSize: 2,
      scrapeMinTier: 3,
      scrapeMaxTimeoutMs: 60000,
      scrapeProxySelection: "roundrobin",
      stallTimeoutMs: 90000,
      closeTimeoutMs: 8000,
      shutdownDrainMs: 0,
      launchTimeoutMs: 45000,
      port: 9000,
      mitmPort: 9001,
      mitmEscalate429: false,
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
      userPrefs: {},
      redisUrl: null,
      sessionCacheDriver: "redis",
      redisSessionTtlSeconds: 3600,
      memorySessionCacheMaxEntries: 1000,
      poolSize: 1,
      maxContentProcesses: 2,
      hardwareConcurrency: null,
      acquireTimeoutMs: 15000,
      recycleAfterContexts: 8,
      headfulPoolSize: 0,
      scrapeMinTier: 1,
      scrapeMaxTimeoutMs: 60000,
      scrapeProxySelection: "failover",
      stallTimeoutMs: 180000,
      closeTimeoutMs: 10000,
      shutdownDrainMs: 0,
      launchTimeoutMs: 90000,
      port: 8191,
      mitmPort: 8192,
      mitmEscalate429: false,
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

  test("requires a sufficiently long dashboard token", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'await import("./config.ts")'],
      cwd: import.meta.dir,
      env: { ...process.env, METRICS_DASHBOARD_TOKEN: "too-short" },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("METRICS_DASHBOARD_TOKEN must be at least 32 characters")
  })
})

test("browser worker sizing is optional and rejects invalid values", async () => {
  const { parseBrowserHardwareConcurrency } = await import("./config")
  expect(parseBrowserHardwareConcurrency(undefined)).toBeUndefined()
  expect(parseBrowserHardwareConcurrency(" ")).toBeUndefined()
  expect(readConfig({ BROWSER_HARDWARE_CONCURRENCY: "4" }).hardwareConcurrency).toBe(4)
  for (const value of ["0", "-1", "1.5", "65", "NaN", "Infinity"]) {
    expect(() => parseBrowserHardwareConcurrency(value)).toThrow("BROWSER_HARDWARE_CONCURRENCY")
  }
})

describe("Firefox user preferences", () => {
  test.each(["", "  ", "{}"])("keeps preferences empty for %s", (value) => {
    expect(readConfig({ USER_PREFS: value }).userPrefs).toEqual({})
  })

  test("accepts Firefox preference values without changing them", () => {
    const prefs = {
      "network.dns.blockDotOnion": false,
      "test.string": "value",
      "test.empty": "",
      "test.integer": 7,
      "test.min": -2147483648,
      "test.max": 2147483647,
    }
    expect(readConfig({ USER_PREFS: JSON.stringify(prefs) }).userPrefs).toEqual(prefs)
  })

  test.each([
    "{",
    "null",
    "[]",
    "true",
    '{"bad":null}',
    '{"bad":[]}',
    '{"bad":{}}',
    '{"bad":0.5}',
    '{"bad":2147483648}',
    '{"bad":-2147483649}',
    '{"bad":1e400}',
  ])("rejects unsupported USER_PREFS %s at startup", (value) => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'await import("./config.ts")'],
      cwd: import.meta.dir,
      env: { ...process.env, USER_PREFS: value },
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("USER_PREFS")
  })
})

test.each([
  ["", "true"],
  ["true", "true"],
  ["invalid", "true"],
  ["false", "false"],
  ["0", "false"],
  [" NO ", "false"],
])(
  "ad blocking parses %j as %s",
  (value, expected) => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", 'console.log((await import("./config.ts")).BROWSER_BLOCK_ADS)'],
      cwd: import.meta.dir,
      env: { ...process.env, BROWSER_BLOCK_ADS: value },
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString().trim()).toBe(expected)
  },
  10000,
)

test.each([
  ["", "0"],
  ["300000", "300000"],
  ["-1", "0"],
  ["1.5", "0"],
  ["invalid", "0"],
])("idle retirement parses %s as %s milliseconds", (value, expected) => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", 'console.log((await import("./config.ts")).BROWSER_IDLE_TIMEOUT_MS)'],
    cwd: import.meta.dir,
    env: { ...process.env, BROWSER_IDLE_TIMEOUT_MS: value },
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString().trim()).toBe(expected)
})

test.each([
  ["", "false"],
  ["true", "true"],
  ["TRUE", "true"],
  ["1", "true"],
  ["yes", "true"],
  ["false", "false"],
  ["0", "false"],
  ["invalid", "false"],
])("cold boot parses %s as %s", (value, expected) => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", 'console.log((await import("./config.ts")).BROWSER_COLD_BOOT)'],
    cwd: import.meta.dir,
    env: { ...process.env, BROWSER_COLD_BOOT: value },
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString().trim()).toBe(expected)
})
