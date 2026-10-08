import { afterEach, describe, expect, test } from "bun:test"
import { BrowserPool, PROXY_SAFETY_FIREFOX_PREFS } from "../src/pool"

const pools: BrowserPool[] = []

const createPool = (opts: ConstructorParameters<typeof BrowserPool>[0]): BrowserPool => {
  const pool = new BrowserPool(opts)
  pools.push(pool)
  return pool
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()))
})

const waitFor = async (predicate: () => boolean, budgetMs = 1000) => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for condition")
}

const NEVER = () => new Promise<void>(() => {})

type MockBrowser = {
  closed: boolean
  isConnected: () => boolean
  close: () => Promise<void>
}
type MockContext = {
  closed: boolean
  pages: () => unknown[]
  close: () => Promise<void>
}

function makeFactory() {
  const browsers: MockBrowser[] = []
  const contexts: MockContext[] = []
  const factory = async () => {
    const browser: MockBrowser = {
      closed: false,
      isConnected() {
        return !this.closed
      },
      async close() {
        this.closed = true
      },
    }
    const context: MockContext = {
      closed: false,
      pages: () => [],
      async close() {
        this.closed = true
      },
    }
    browsers.push(browser)
    contexts.push(context)
    return { browser, context }
  }
  return { factory, browsers, contexts }
}

describe("BrowserPool mode", () => {
  test("marks leases from a virtual-display pool as headful", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 2, virtualDisplay: true, browserFactory: factory })
    await pool.init()

    const first = await pool.acquire()
    const second = await pool.acquire()
    expect(first.headful).toBeTrue()
    expect(second.headful).toBeTrue()

    pool.release(first.id, first.lease)
    expect(pool.getStats().available).toBe(1)
  })
})

describe("BrowserPool recycling", () => {
  test("prevents direct fallback and local DNS resolution for proxied navigations", () => {
    expect(PROXY_SAFETY_FIREFOX_PREFS["network.proxy.failover_direct"]).toBeFalse()
    expect(PROXY_SAFETY_FIREFOX_PREFS["network.proxy.socks_remote_dns"]).toBeTrue()
  })

  test("publishes the first browser before warming remaining capacity concurrently", async () => {
    const { factory: baseFactory } = makeFactory()
    let activeLaunches = 0
    let maxActiveLaunches = 0
    let releaseFirst: (() => void) | undefined
    let releaseRest: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const restGate = new Promise<void>((resolve) => (releaseRest = resolve))
    let launchNumber = 0
    const factory = async () => {
      const current = launchNumber++
      activeLaunches++
      maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches)
      await (current === 0 ? firstGate : restGate)
      activeLaunches--
      return baseFactory()
    }
    const pool = createPool({ poolSize: 3, browserFactory: factory, acquireTimeoutMs: 250 })

    const initializing = pool.init()
    await waitFor(() => maxActiveLaunches === 1)
    releaseFirst?.()
    await waitFor(() => pool.getStats().available === 1)
    await waitFor(() => maxActiveLaunches === 2)

    const handle = await pool.acquire("example.com")
    pool.release(handle.id, handle.lease)
    expect(maxActiveLaunches).toBe(2)

    releaseRest?.()
    await initializing
    expect(pool.getStats().available).toBe(3)
  })

  test("launch timeout diagnoses outbound network and GeoIP availability", async () => {
    const pool = createPool({
      poolSize: 1,
      launchTimeoutMs: 20,
      browserFactory: NEVER,
    })

    await expect(pool.init()).rejects.toThrow("browser launch exceeded 20ms; check outbound network and GeoIP access")
  })

  test("restarts the browser after the temporary context threshold", async () => {
    const { factory, browsers, contexts } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 2,
      browserFactory: factory,
    })

    await pool.init()

    const first = await pool.acquire("example.com")
    first.noteTemporaryContext?.("tier3 fresh context")
    pool.release(first.id)

    expect(pool.getStats().restarts).toBe(0)
    expect(pool.getStats().available).toBe(1)

    const second = await pool.acquire("example.com")
    second.noteTemporaryContext?.("tier3 fresh context")
    pool.release(second.id)

    await waitFor(() => pool.getStats().restarts === 1)

    expect(contexts[0].closed).toBe(true)
    expect(browsers[0].closed).toBe(true)
    expect(pool.getStats().available).toBe(1)
    expect(browsers).toHaveLength(2)
  })

  test("noteTemporaryContext is no-op when recycleAfterTemporaryContexts=0", async () => {
    const { factory, browsers } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 0, // disabled
      browserFactory: factory,
    })

    await pool.init()

    // Hammer the pool with noteTemporaryContext — should never trigger recycle.
    for (let i = 0; i < 20; i++) {
      const handle = await pool.acquire("example.com")
      handle.noteTemporaryContext?.("tier3 blocked")
      pool.release(handle.id)
    }

    // No recycle should have happened — only the initial browser exists.
    expect(pool.getStats().restarts).toBe(0)
    expect(browsers).toHaveLength(1)
  })

  test("counts every reported temporary context independent of outcome", async () => {
    const { factory, browsers } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 2,
      browserFactory: factory,
    })

    await pool.init()

    for (const _outcome of ["success", "timeout"]) {
      const handle = await pool.acquire("example.com")
      handle.noteTemporaryContext?.()
      pool.release(handle.id)
    }

    await waitFor(() => pool.getStats().restarts === 1)
    expect(browsers).toHaveLength(2)
  })

  test("pool size 1 stays acquirable while a replacement is launching", async () => {
    const { factory: baseFactory } = makeFactory()
    let finishLaunch: (() => void) | undefined
    let launches = 0
    const factory = async () => {
      launches++
      if (launches === 2) await new Promise<void>((resolve) => (finishLaunch = resolve))
      return baseFactory()
    }
    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 1,
      acquireTimeoutMs: 50,
      browserFactory: factory,
    })
    await pool.init()
    const first = await pool.acquire("example.com")
    first.noteTemporaryContext?.()
    pool.release(first.id, first.lease)
    await waitFor(() => launches === 2)

    const duringWarmup = await pool.acquire("example.com")
    expect(pool.getStats().live).toBe(1)
    // This context belongs to the incumbent that is about to be retired. It must not
    // schedule a second replacement after the warmed browser is installed.
    duringWarmup.noteTemporaryContext?.()
    finishLaunch?.()
    pool.release(duringWarmup.id, duringWarmup.lease)
    await waitFor(() => pool.getStats().restarts === 1)
    const afterInstall = await pool.acquire("example.com")
    pool.release(afterInstall.id, afterInstall.lease)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(launches).toBe(2)
  })

  test("warms only one replacement across the pool", async () => {
    const { factory: baseFactory } = makeFactory()
    let finishFirstReplacement: (() => void) | undefined
    let launches = 0
    const factory = async () => {
      launches++
      if (launches === 3) await new Promise<void>((resolve) => (finishFirstReplacement = resolve))
      return baseFactory()
    }
    const pool = createPool({ poolSize: 2, recycleAfterTemporaryContexts: 1, browserFactory: factory })
    await pool.init()

    const first = await pool.acquire("one.example")
    const second = await pool.acquire("two.example")
    first.noteTemporaryContext?.()
    second.noteTemporaryContext?.()
    pool.release(first.id, first.lease)
    pool.release(second.id, second.lease)

    await waitFor(() => launches === 3)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(launches).toBe(3)
    finishFirstReplacement?.()
    await waitFor(() => launches === 4)
    await waitFor(() => pool.getStats().restarts === 2)
  })

  test("contentProcesses option is stored without crashing", async () => {
    // We can't easily test that Camoufox is called with the right `prefs` block
    // without mocking the Camoufox module itself. This test verifies that the
    // option round-trips through the constructor without error.
    const { factory } = makeFactory()

    const pool = createPool({
      poolSize: 1,
      contentProcesses: 4,
      browserFactory: factory,
    })

    await pool.init()
    expect(pool.getStats().total).toBe(1)
  })
})

// Regression tests for a wedge seen in long-running deployments: /health kept reporting
// 200/"ok" with zero usable browsers, while the pool's restart counter stayed frozen and
// the health check logged "browser N disconnected, restarting" forever without restarting.
describe("BrowserPool wedge recovery", () => {
  test("a browser whose close() never resolves does not strand the entry in restarting", async () => {
    // The failure: restartEntry awaited context.close() with no bound, the
    // close never settled, and `restarting` stayed true forever. From then on the 30s
    // health check hit the `if (entry.restarting) return` guard and could only log —
    // the entry was never rebuilt and never counted as available again.
    const browsers: MockBrowser[] = []
    const factory = async () => {
      const browser: MockBrowser = {
        closed: false,
        isConnected() {
          return !this.closed
        },
        // First browser hangs on close, exactly like Camoufox with a wedged content
        // process. Replacements close normally.
        close:
          browsers.length === 0
            ? NEVER
            : async function (this: MockBrowser) {
                this.closed = true
              },
      }
      const context: MockContext = {
        closed: false,
        pages: () => [],
        close:
          browsers.length === 0
            ? NEVER
            : async function (this: MockContext) {
                this.closed = true
              },
      }
      browsers.push(browser)
      return { browser, context }
    }

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 1,
      closeTimeoutMs: 50,
      browserFactory: factory,
    })
    await pool.init()

    const handle = await pool.acquire("example.com")
    handle.noteTemporaryContext?.("tier4 blocked")
    pool.release(handle.id, handle.lease)

    // Before the fix this never happened — the pool sat at restarts=0, available=0.
    await waitFor(() => pool.getStats().restarts === 1)
    expect(pool.getStats().available).toBe(1)
    expect(pool.getStats().live).toBe(1)
    expect(browsers).toHaveLength(2)
  })

  test("synchronous close errors do not strand a recycled entry", async () => {
    let launches = 0
    const factory = async () => {
      launches++
      return {
        browser: {
          isConnected: () => true,
          close: () => {
            if (launches === 1) throw new Error("browser close failed")
          },
        },
        context: {
          pages: () => [
            {
              close: () => {
                throw new Error("page close failed")
              },
            },
          ],
          close: () => {
            if (launches === 1) throw new Error("context close failed")
          },
        },
      }
    }
    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 1,
      closeTimeoutMs: 20,
      browserFactory: factory,
    })
    await pool.init()

    const handle = await pool.acquire("example.com")
    handle.noteTemporaryContext?.("blocked")
    expect(() => pool.release(handle.id, handle.lease)).not.toThrow()

    await waitFor(() => pool.getStats().restarts === 1)
    expect(pool.getStats().live).toBe(1)
    expect(launches).toBe(2)
  })

  test("a synchronous pages() error does not escape release", async () => {
    const pool = createPool({
      poolSize: 1,
      browserFactory: async () => ({
        browser: { isConnected: () => true, close: async () => {} },
        context: {
          pages: () => {
            throw new Error("pages failed")
          },
          close: async () => {},
        },
      }),
    })
    await pool.init()

    const handle = await pool.acquire("example.com")
    expect(() => pool.release(handle.id, handle.lease)).not.toThrow()
    expect(pool.getStats().available).toBe(1)
  })

  test("a timed-out rolling replacement leaves the existing browser usable", async () => {
    let launches = 0
    const factory = async () => {
      launches++
      // Second launch (the restart) hangs — camoufox-js can block before Playwright's
      // own launch timeout ever applies.
      if (launches === 2) await NEVER()
      const browser: MockBrowser = {
        closed: false,
        isConnected() {
          return !this.closed
        },
        async close() {
          this.closed = true
        },
      }
      const context: MockContext = {
        closed: false,
        pages: () => [],
        async close() {
          this.closed = true
        },
      }
      return { browser, context }
    }

    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 1,
      closeTimeoutMs: 20,
      launchTimeoutMs: 50,
      healthIntervalMs: 30,
      browserFactory: factory,
    })
    await pool.init()
    pool.startHealthCheck()

    const handle = await pool.acquire("example.com")
    handle.noteTemporaryContext?.("tier4 blocked")
    pool.release(handle.id, handle.lease)

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pool.getStats().live).toBe(1)
    const stillUsable = await pool.acquire("example.com")
    pool.release(stillUsable.id, stillUsable.lease)
    await waitFor(() => pool.getStats().restarts === 1, 3000)
    await pool.shutdown()
  })

  test("a stalled checkout is not counted as live capacity", async () => {
    // This is the exact arithmetic that defeated the old `available + busy > 0` gate:
    // total=1, busy=1, available=0 — which read as "ok" despite nothing being usable.
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 1, stallAfterMs: 40, browserFactory: factory })
    await pool.init()

    const handle = await pool.acquire("example.com")
    expect(pool.getStats().busy).toBe(1)
    expect(pool.getStats().live).toBe(1) // genuinely in-flight work still counts

    await new Promise((r) => setTimeout(r, 60))

    const stats = pool.getStats()
    expect(stats.busy).toBe(1)
    expect(stats.available).toBe(0)
    expect(stats.stalled).toBe(1)
    expect(stats.live).toBe(0) // …and the old gate would have said "ok" here
    expect(handle.id).toBe(0)
  })

  test("a busy entry whose browser died is not counted as live capacity", async () => {
    // The health check never probes busy entries, so a checkout whose browser dies would
    // otherwise read as capacity right up until its stall deadline — the same "200 with
    // nothing usable" failure the gate exists to prevent, just on a timer.
    const { factory, browsers } = makeFactory()
    const pool = createPool({ poolSize: 1, stallAfterMs: 60_000, browserFactory: factory })
    await pool.init()

    const handle = await pool.acquire("example.com", 60_000)
    expect(pool.getStats().live).toBe(1)

    // Browser dies mid-request; nothing releases it and it is nowhere near its deadline.
    browsers[0].closed = true

    const stats = pool.getStats()
    expect(stats.busy).toBe(1)
    expect(stats.stalled).toBe(0) // still inside its budget…
    expect(stats.live).toBe(0) // …but not usable, so not capacity
    expect(handle.id).toBe(0)
  })

  test("reclaims a disconnected browser during checkout without waiting for its budget", async () => {
    const { factory, browsers } = makeFactory()
    const pool = createPool({
      poolSize: 1,
      stallAfterMs: 60_000,
      healthIntervalMs: 20,
      browserFactory: factory,
    })
    await pool.init()
    pool.startHealthCheck()

    const abandoned = await pool.acquire("example.com", 60_000)
    browsers[0].closed = true
    await waitFor(() => pool.getStats().restarts === 1)

    const current = await pool.acquire("example.com")
    pool.release(abandoned.id, abandoned.lease)
    expect(pool.getStats().busy).toBe(1)
    pool.release(current.id, current.lease)
    expect(pool.getStats().available).toBe(1)
  })

  test("reports active checkout age and real queue depth", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 1, acquireTimeoutMs: 80, pollIntervalMs: 10, browserFactory: factory })
    await pool.init()

    const first = await pool.acquire("example.com")
    const waiting = pool.acquire("example.org")
    expect(pool.getStats().queueDepth).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pool.getStats().longestBusyMs).toBeGreaterThanOrEqual(20)
    pool.release(first.id, first.lease)
    const second = await waiting
    expect(pool.getStats().queueDepth).toBe(0)
    pool.release(second.id, second.lease)
    expect(pool.getStats().longestBusyMs).toBe(0)
  })

  test("clears queue depth when a waiting acquire times out", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 1, acquireTimeoutMs: 30, pollIntervalMs: 10, browserFactory: factory })
    await pool.init()
    const held = await pool.acquire()
    const waiting = pool.acquire()
    expect(pool.getStats().queueDepth).toBe(1)
    await expect(waiting).rejects.toThrow("Browser pool exhausted")
    expect(pool.getStats().queueDepth).toBe(0)
    pool.release(held.id, held.lease)
  })

  test("a checkout inside the caller's own budget is never reclaimed", async () => {
    // Callers may pass req.maxTimeout larger than the stall threshold. Reclaiming on the
    // threshold alone would close the browser out from under a request that is still
    // well inside the time it asked for.
    const { factory } = makeFactory()
    const pool = createPool({
      poolSize: 1,
      stallAfterMs: 40,
      healthIntervalMs: 20,
      browserFactory: factory,
    })
    await pool.init()
    pool.startHealthCheck()

    // Budget of 5s dwarfs the 40ms stall threshold — this checkout must survive.
    const handle = await pool.acquire("example.com", 5000)
    await new Promise((r) => setTimeout(r, 300))

    const stats = pool.getStats()
    expect(stats.stalled).toBe(0)
    expect(stats.restarts).toBe(0)
    expect(stats.busy).toBe(1)
    expect(stats.live).toBe(1)

    pool.release(handle.id, handle.lease)
    await pool.shutdown()
  })

  test("the health check reclaims a stalled checkout, and its late release is ignored", async () => {
    const { factory } = makeFactory()
    const pool = createPool({
      poolSize: 1,
      stallAfterMs: 40,
      healthIntervalMs: 20,
      browserFactory: factory,
    })
    await pool.init()
    pool.startHealthCheck()

    // A request that wedges mid-solve: acquired, never released.
    const abandoned = await pool.acquire("example.com")

    await waitFor(() => pool.getStats().restarts === 1, 2000)
    expect(pool.getStats().live).toBe(1)

    // Someone else now holds the rebuilt browser.
    const current = await pool.acquire("example.com")
    expect(pool.getStats().busy).toBe(1)

    // The abandoned request finally unwinds and calls release(). Its lease is stale, so
    // it must not free the checkout that `current` is holding.
    pool.release(abandoned.id, abandoned.lease)
    expect(pool.getStats().busy).toBe(1)

    pool.release(current.id, current.lease)
    expect(pool.getStats().busy).toBe(0)
    await pool.shutdown()
  })
})

describe("Firefox launch preferences", () => {
  test.each([false, true])("passes custom prefs and enforces proxy safety for virtualDisplay=%s", (virtualDisplay) => {
    const script = `
      import { mock } from "bun:test"
      let options
      mock.module("camoufox-js", () => ({ Camoufox: async (input) => {
        options = input
        return {
          newContext: async () => ({ pages: () => [], addInitScript: async () => {}, close: async () => {} }),
          isConnected: () => true,
          close: async () => {},
        }
      }}))
      const { BrowserPool } = await import("../src/pool.ts")
      const pool = new BrowserPool({ poolSize: 1, virtualDisplay: ${virtualDisplay}, userPrefs: {
        "network.dns.blockDotOnion": false,
        "network.proxy.failover_direct": true,
        "network.proxy.socks_remote_dns": false,
        "test.string": "value",
        "test.integer": 7,
      }})
      try {
        await pool.init()
        console.log(JSON.stringify({ headless: options.headless, prefs: options.firefox_user_prefs }))
      } finally { await pool.shutdown() }
    `
    const result = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: import.meta.dir })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const options = JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "")
    expect(options.headless).toBe(virtualDisplay ? "virtual" : true)
    expect(options.prefs).toMatchObject({
      "network.dns.blockDotOnion": false,
      "network.proxy.failover_direct": false,
      "network.proxy.socks_remote_dns": true,
      "test.string": "value",
      "test.integer": 7,
      "dom.ipc.processCount": 2,
    })
  })
})

describe("BrowserPool resource limits", () => {
  test("queue waiting respects the caller budget instead of the pool timeout", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 1, acquireTimeoutMs: 1000, pollIntervalMs: 200, browserFactory: factory })
    await pool.init()
    const held = await pool.acquire()
    const start = performance.now()
    await expect(pool.acquire("queued.test", 30)).rejects.toThrow("Browser pool exhausted")
    expect(performance.now() - start).toBeLessThan(150)
    expect(pool.getStats().queueDepth).toBe(0)
    pool.release(held.id, held.lease)
  })

  test("an exhausted request budget cannot acquire an idle browser", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 1, browserFactory: factory })
    await pool.init()
    await expect(pool.acquire("expired.test", 0)).rejects.toThrow("Browser pool exhausted")
    expect(pool.getStats().available).toBe(1)
  })

  test("release wakes queued work without a polling interval", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 1, pollIntervalMs: 500, browserFactory: factory })
    await pool.init()
    const held = await pool.acquire()
    const queued = pool.acquire("queued.test", 1000)
    const start = performance.now()
    pool.release(held.id, held.lease)
    const next = await queued
    expect(performance.now() - start).toBeLessThan(150)
    pool.release(next.id, next.lease)
  })

  test("acquisition recovers a disconnected browser without a health tick", async () => {
    const { factory, browsers } = makeFactory()
    const pool = createPool({ poolSize: 1, browserFactory: factory })
    await pool.init()
    browsers[0].closed = true
    const next = await pool.acquire("recovery.test", 1000)
    expect(next.browser).toBe(browsers[1])
    expect(next.browser.isConnected()).toBeTrue()
    expect(pool.getStats().restarts).toBe(1)
    pool.release(next.id, next.lease)
  })

  test.each([100, 800])("retires first in a 1 GiB container with %s MiB usage", async (usageMiB) => {
    const { factory: baseFactory, browsers } = makeFactory()
    let overlap = false
    const factory = async () => {
      if (browsers.some((browser) => !browser.closed)) overlap = true
      return baseFactory()
    }
    const pool = createPool({
      poolSize: 1,
      browserFactory: factory,
      recycleAfterTemporaryContexts: 1,
      memoryUsage: () => ({ currentBytes: usageMiB * 1024 ** 2, limitBytes: 1024 ** 3 }),
    } as ConstructorParameters<typeof BrowserPool>[0])
    await pool.init()
    const held = await pool.acquire()
    held.noteTemporaryContext?.()
    expect(browsers[0].closed).toBeFalse()
    pool.release(held.id, held.lease)
    await waitFor(() => pool.getStats().restarts === 1)
    expect(overlap).toBeFalse()
    expect(pool.getStats().available).toBe(1)
  })

  test("memory pressure triggers cleanup even with context-count recycling disabled", async () => {
    const { factory, browsers } = makeFactory()
    const pool = createPool({
      poolSize: 1,
      browserFactory: factory,
      recycleAfterTemporaryContexts: 0,
      memoryUsage: () => ({ currentBytes: 950 * 1024 ** 2, limitBytes: 1024 ** 3 }),
    } as ConstructorParameters<typeof BrowserPool>[0])
    await pool.init()
    const held = await pool.acquire()
    pool.release(held.id, held.lease)
    await waitFor(() => pool.getStats().restarts === 1)
    expect(browsers[0].closed).toBeTrue()
  })
})

describe("BrowserPool queued lifecycle", () => {
  test("shutdown rejects queued callers immediately", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 1, acquireTimeoutMs: 1000, browserFactory: factory })
    await pool.init()
    await pool.acquire()
    const queued = pool.acquire()
    const assertion = expect(queued).rejects.toThrow("Browser pool exhausted")
    await pool.shutdown()
    await assertion
    expect(pool.getStats().queueDepth).toBe(0)
  })

  test("retains warm recycling when the container has enough headroom", async () => {
    const { factory: baseFactory, browsers } = makeFactory()
    let overlap = false
    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 1,
      memoryUsage: () => ({ currentBytes: 500 * 1024 ** 2, limitBytes: 2 * 1024 ** 3 }),
      browserFactory: async () => {
        if (browsers.some((browser) => !browser.closed)) overlap = true
        return baseFactory()
      },
    })
    await pool.init()
    const held = await pool.acquire()
    held.noteTemporaryContext?.()
    pool.release(held.id, held.lease)
    await waitFor(() => pool.getStats().restarts === 1)
    expect(overlap).toBeTrue()
    expect(browsers[0].closed).toBeTrue()
  })

  test("does not install a warmed browser over concurrent crash recovery", async () => {
    const { factory: baseFactory, browsers } = makeFactory()
    let launches = 0
    let finishWarm: (() => void) | undefined
    const pool = createPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 1,
      healthIntervalMs: 10,
      browserFactory: async () => {
        const launch = ++launches
        if (launch === 2)
          await new Promise<void>((resolve) => {
            finishWarm = resolve
          })
        return baseFactory()
      },
    })
    await pool.init()
    pool.startHealthCheck()
    const held = await pool.acquire()
    held.noteTemporaryContext?.()
    pool.release(held.id, held.lease)
    await waitFor(() => launches === 2)
    browsers[0].closed = true
    await waitFor(() => pool.getStats().restarts === 1)
    const recovered = await pool.acquire()
    finishWarm?.()
    pool.release(recovered.id, recovered.lease)
    await waitFor(() => browsers.length === 3 && browsers[2].closed)
    expect(pool.getStats().restarts).toBe(1)
    const next = await pool.acquire()
    expect(next.browser).toBe(recovered.browser)
    pool.release(next.id, next.lease)
  })
})

describe("Optional ad blocking", () => {
  test.each([true, false])("sets uBlock exclusion for blockAds=%s", (blockAds) => {
    const script = `
      import { mock } from "bun:test"
      let excluded
      mock.module("camoufox-js", () => ({ Camoufox: async (options) => {
        excluded = options.exclude_addons
        return { newContext: async () => ({ addInitScript: async () => {}, close: async () => {} }),
          isConnected: () => true, close: async () => {} }
      }}))
      const { BrowserPool } = await import("../src/pool.ts")
      const pool = new BrowserPool({ poolSize: 1, blockAds: ${blockAds} })
      await pool.init(); await pool.shutdown()
      console.log(JSON.stringify(excluded))
    `
    const result = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: import.meta.dir })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "")).toEqual(blockAds ? [] : ["UBO"])
  })
})

test("inactive file cache does not cause memory-pressure recycling", async () => {
  const { factory, browsers } = makeFactory()
  const pool = createPool({
    poolSize: 1,
    browserFactory: factory,
    recycleAfterTemporaryContexts: 0,
    memoryUsage: () => ({ currentBytes: 950 * 1024 ** 2, workingSetBytes: 450 * 1024 ** 2, limitBytes: 1024 ** 3 }),
  })
  await pool.init()
  const held = await pool.acquire()
  held.noteTemporaryContext?.()
  pool.release(held.id, held.lease)
  await Bun.sleep(20)
  expect(browsers).toHaveLength(1)
  expect(pool.getStats().available).toBe(1)
})

test("a retained context closing restarts the entry even with a connected browser", async () => {
  const { factory: baseFactory } = makeFactory()
  const closes: Array<() => void> = []
  const pool = createPool({
    poolSize: 1,
    browserFactory: async () => {
      const result = await baseFactory()
      return { ...result, context: { ...result.context, once: (_: string, close: () => void) => closes.push(close) } }
    },
  })
  await pool.init()
  const first = await pool.acquire()
  closes[0]()
  const next = await pool.acquire("recovered.test", 1000)
  expect(next.browser).not.toBe(first.browser)
  pool.release(first.id, first.lease)
  expect(pool.getStats().busy).toBe(1)
  pool.release(next.id, next.lease)
  closes[0]()
  await Bun.sleep(20)
  expect(pool.getStats().restarts).toBe(1)
})

test("queued work uses a ready replacement instead of reacquiring the retired browser", async () => {
  const { factory: baseFactory, browsers } = makeFactory()
  let launches = 0
  let finishWarm: (() => void) | undefined
  const pool = createPool({
    poolSize: 1,
    recycleAfterTemporaryContexts: 1,
    pollIntervalMs: 100,
    browserFactory: async () => {
      if (++launches === 2)
        await new Promise<void>((resolve) => {
          finishWarm = resolve
        })
      return baseFactory()
    },
  })
  await pool.init()
  const first = await pool.acquire()
  first.noteTemporaryContext?.()
  pool.release(first.id, first.lease)
  const incumbent = await pool.acquire()
  finishWarm?.()
  await waitFor(() => browsers.length === 2)
  const queued = pool.acquire("next.test", 1000)
  pool.release(incumbent.id, incumbent.lease)
  const next = await queued
  expect(next.browser).toBe(browsers[1])
  pool.release(next.id, next.lease)
})

describe("release cleanup", () => {
  test("waits for pages to close before reacquiring and assessing memory", async () => {
    const { factory, contexts } = makeFactory()
    let memory = 950 * 1024 ** 2
    const pool = createPool({
      poolSize: 1,
      browserFactory: factory,
      recycleAfterTemporaryContexts: 0,
      memoryUsage: () => ({ currentBytes: memory, workingSetBytes: memory, limitBytes: 1024 ** 3 }),
    })
    await pool.init()
    let finishClose!: () => void
    contexts[0].pages = () => [
      {
        close: () =>
          new Promise<void>((resolve) => {
            finishClose = () => {
              memory = 500 * 1024 ** 2
              resolve()
            }
          }),
      },
    ]
    const first = await pool.acquire()
    pool.release(first.id, first.lease)
    const next = pool.acquire()
    let acquired = false
    void next.then(() => {
      acquired = true
    })
    await Bun.sleep(20)
    expect(acquired).toBeFalse()
    finishClose()
    const second = await next
    expect(pool.getStats().restarts).toBe(0)
    contexts[0].pages = () => []
    pool.release(second.id, second.lease)
  })
})

describe("optional idle retirement", () => {
  test("retires idle browsers and wakes only one for concurrent acquires", async () => {
    const { factory, browsers } = makeFactory()
    const pool = createPool({ poolSize: 1, browserFactory: factory, idleTimeoutMs: 30, healthIntervalMs: 10 })
    await pool.init()
    pool.startHealthCheck()
    await waitFor(() => pool.getStats().sleeping === 1)
    expect(browsers[0].closed).toBeTrue()
    expect(pool.getStats().live).toBe(0)
    const first = await pool.acquire()
    const queued = pool.acquire()
    expect(browsers).toHaveLength(2)
    await Bun.sleep(40)
    expect(pool.getStats().sleeping).toBe(0)
    expect(browsers[1].closed).toBeFalse()
    pool.release(first.id, first.lease)
    const next = await queued
    pool.release(next.id, next.lease)
  })

  test("keeps warm browsers by default", async () => {
    const { factory, browsers } = makeFactory()
    const pool = createPool({ poolSize: 1, browserFactory: factory, healthIntervalMs: 10 })
    await pool.init()
    pool.startHealthCheck()
    await Bun.sleep(50)
    expect(pool.getStats().sleeping).toBe(0)
    expect(browsers[0].closed).toBeFalse()
  })
})

test("cancelling an acquire removes its waiter before capacity becomes available", async () => {
  const { factory } = makeFactory()
  const pool = createPool({ poolSize: 1, browserFactory: factory })
  await pool.init()
  const held = await pool.acquire()
  const controller = new AbortController()
  const queued = pool.acquire("cancelled.test", 5000, controller.signal)
  expect(pool.getStats().queueDepth).toBe(1)
  controller.abort()
  await expect(queued).rejects.toThrow()
  expect(pool.getStats().queueDepth).toBe(0)
  pool.release(held.id, held.lease)
  expect(pool.getStats().available).toBe(1)
})

test("warm replacement waits for cleanup of the incumbent lease", async () => {
  const { factory, contexts, browsers } = makeFactory()
  let launches = 0
  let finishWarm!: () => void
  const pool = createPool({
    poolSize: 1,
    browserFactory: async () => {
      if (++launches === 2)
        await new Promise<void>((resolve) => {
          finishWarm = resolve
        })
      return factory()
    },
    recycleAfterTemporaryContexts: 1,
    pollIntervalMs: 5,
  })
  await pool.init()
  const first = await pool.acquire()
  first.noteTemporaryContext?.()
  pool.release(first.id, first.lease)
  const held = await pool.acquire()
  let finishClose!: () => void
  contexts[0].pages = () => [
    {
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        }),
    },
  ]
  finishWarm()
  await waitFor(() => browsers.length === 2)
  pool.release(held.id, held.lease)
  const queued = pool.acquire()
  await Bun.sleep(20)
  expect(pool.getStats().available).toBe(0)
  expect(pool.getStats().restarts).toBe(0)
  finishClose()
  const next = await queued
  expect(next.browser).toBe(browsers[1])
  pool.release(next.id, next.lease)
  expect(pool.getStats().available).toBe(1)
})

test("idle retirement still closes the browser when its context close hangs", async () => {
  const { factory, contexts, browsers } = makeFactory()
  const pool = createPool({
    poolSize: 1,
    browserFactory: factory,
    idleTimeoutMs: 30,
    healthIntervalMs: 5,
    closeTimeoutMs: 20,
  })
  await pool.init()
  contexts[0].close = NEVER
  pool.startHealthCheck()
  await waitFor(() => pool.getStats().sleeping === 1)
  expect(browsers[0].closed).toBeTrue()
  const next = await pool.acquire()
  expect(next.browser).toBe(browsers[1])
  expect(pool.getStats().restarts).toBe(1)
  pool.release(next.id, next.lease)
})

describe("persistent session leases", () => {
  test("a pinned acquire waits for its browser even when another slot is free", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 2, browserFactory: factory, acquireTimeoutMs: 50 })
    await pool.init()
    const first = await pool.acquire()
    await expect(pool.acquire(undefined, 15, undefined, first.id)).rejects.toThrow("exhausted")
    pool.release(first.id, first.lease)
    const pinned = await pool.acquire("other.example", 50, undefined, first.id)
    expect(pinned.browser).toBe(first.browser)
    pool.release(pinned.id, pinned.lease)
  })

  test("retention postpones count recycling but releasing it restores recycling", async () => {
    const { factory, browsers } = makeFactory()
    const pool = createPool({ poolSize: 1, browserFactory: factory, recycleAfterTemporaryContexts: 1 })
    await pool.init()
    const handle = await pool.acquire()
    const releaseRetention = handle.retainBrowser?.()
    if (!releaseRetention) throw new Error("Missing browser retention")
    handle.noteTemporaryContext?.()
    pool.release(handle.id, handle.lease)
    await Bun.sleep(20)
    expect(browsers).toHaveLength(1)
    const second = await pool.acquire()
    expect(second.browser).toBe(handle.browser)
    pool.release(second.id, second.lease)
    releaseRetention()
    releaseRetention()
    await waitFor(() => browsers.length === 2 && browsers[0].closed)
  })

  test("retention never suppresses the container memory guard", async () => {
    const { factory, browsers } = makeFactory()
    const pool = createPool({
      poolSize: 1,
      browserFactory: factory,
      recycleAfterTemporaryContexts: 1,
      memoryUsage: () => ({ limitBytes: 1024 ** 3, currentBytes: 950 * 1024 ** 2, workingSetBytes: 950 * 1024 ** 2 }),
    })
    await pool.init()
    const handle = await pool.acquire()
    const releaseRetention = handle.retainBrowser?.()
    if (!releaseRetention) throw new Error("Missing browser retention")
    handle.noteTemporaryContext?.()
    pool.release(handle.id, handle.lease)
    await waitFor(() => browsers.length === 2 && browsers[0].closed)
    releaseRetention()
  })
})

test("session retention never postpones cleanup recovery, including a previous lease on the same browser", async () => {
  const { factory, browsers } = makeFactory()
  const pool = createPool({ poolSize: 1, browserFactory: factory })
  await pool.init()
  const first = await pool.acquire()
  const releaseRetention = first.retainBrowser?.()
  if (!releaseRetention) throw new Error("Missing browser retention")
  pool.release(first.id, first.lease)
  const second = await pool.acquire()
  first.requestBrowserReplacement?.("session context cleanup timed out")
  expect(browsers).toHaveLength(1)
  pool.release(second.id, second.lease)
  await waitFor(() => browsers.length === 2 && browsers[0].closed)
  releaseRetention()
  first.requestBrowserReplacement?.("old browser cleanup")
  await Bun.sleep(10)
  expect(browsers).toHaveLength(2)
})

test("a completed recovery clears requests made while the replacement was warming", async () => {
  const { factory, browsers } = makeFactory()
  let launches = 0
  let finishWarm!: () => void
  const pool = createPool({
    poolSize: 1,
    recycleAfterTemporaryContexts: 1,
    browserFactory: async () => {
      launches++
      if (launches === 2)
        await new Promise<void>((resolve) => {
          finishWarm = resolve
        })
      return factory()
    },
  })
  await pool.init()
  const first = await pool.acquire()
  first.requestBrowserReplacement?.("cleanup recovery")
  pool.release(first.id, first.lease)
  await waitFor(() => launches === 2)
  const duringWarm = await pool.acquire()
  duringWarm.requestBrowserReplacement?.("second cleanup recovery")
  pool.release(duringWarm.id, duringWarm.lease)
  finishWarm()
  await waitFor(() => browsers.length === 2 && browsers[0].closed)
  const recovered = await pool.acquire()
  const releaseRetention = recovered.retainBrowser?.()
  if (!releaseRetention) throw new Error("Missing browser retention")
  recovered.noteTemporaryContext?.()
  pool.release(recovered.id, recovered.lease)
  await Bun.sleep(20)
  expect(launches).toBe(2)
  releaseRetention()
})
