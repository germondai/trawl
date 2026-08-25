import { afterEach, describe, expect, test } from "bun:test"
import { BrowserPool } from "../src/pool"

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

describe("BrowserPool identity", () => {
  test("keeps a sub-pool's browser ids in its own range so releases can be routed", async () => {
    const { factory } = makeFactory()
    const pool = createPool({ poolSize: 2, idOffset: 1000, browserFactory: factory })
    await pool.init()

    const first = await pool.acquire()
    const second = await pool.acquire()
    expect([first.id, second.id].sort((a, b) => a - b)).toEqual([1000, 1001])

    pool.release(first.id, first.lease)
    expect(pool.getStats().available).toBe(1)
  })
})

describe("BrowserPool recycling", () => {
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
