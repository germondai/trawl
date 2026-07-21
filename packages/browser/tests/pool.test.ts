import { describe, expect, test } from "bun:test"
import { BrowserPool } from "../src/pool"

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

describe("BrowserPool recycling", () => {
  test("restarts the browser after the temporary context threshold", async () => {
    const { factory, browsers, contexts } = makeFactory()

    const pool = new BrowserPool({
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

    const pool = new BrowserPool({
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

  test("successful acquires do NOT trigger recycle (recycle driven by orchestrator, not pool)", async () => {
    // Documents the contract: the pool itself does NOT decide when to recycle based
    // on temporary-context count. The orchestrator decides (by calling
    // noteTemporaryContext only on blocked/needs-js outcomes). This test verifies
    // that the pool, given N successful acquires, never recycles on its own.
    const { factory, browsers } = makeFactory()

    const pool = new BrowserPool({
      poolSize: 1,
      recycleAfterTemporaryContexts: 2,
      browserFactory: factory,
    })

    await pool.init()

    // Simulate 10 "successful" Tier 3 attempts that the orchestrator does NOT flag.
    // (No noteTemporaryContext calls.) Pool should never recycle.
    for (let i = 0; i < 10; i++) {
      const handle = await pool.acquire("example.com")
      pool.release(handle.id)
    }

    expect(pool.getStats().restarts).toBe(0)
    expect(browsers).toHaveLength(1)
  })

  test("contentProcesses option is stored without crashing", async () => {
    // We can't easily test that Camoufox is called with the right `prefs` block
    // without mocking the Camoufox module itself. This test verifies that the
    // option round-trips through the constructor without error.
    const { factory } = makeFactory()

    const pool = new BrowserPool({
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

    const pool = new BrowserPool({
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

  test("a launch that never resolves fails the restart instead of hanging it", async () => {
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

    const pool = new BrowserPool({
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

    // Wait for the restart to actually be in flight (entry detached, no capacity) before
    // asserting recovery — otherwise this passes on the pre-restart state and proves
    // nothing.
    await waitFor(() => pool.getStats().live === 0, 2000)
    // The hung launch is then abandoned, `restarting` clears, and the next health-check
    // tick retries the entry from scratch — so the pool heals rather than wedging here.
    await waitFor(() => pool.getStats().live === 1, 3000)
    await pool.shutdown()
  })

  test("a stalled checkout is not counted as live capacity", async () => {
    // This is the exact arithmetic that defeated the old `available + busy > 0` gate:
    // total=1, busy=1, available=0 — which read as "ok" despite nothing being usable.
    const { factory } = makeFactory()
    const pool = new BrowserPool({ poolSize: 1, stallAfterMs: 40, browserFactory: factory })
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
    const pool = new BrowserPool({ poolSize: 1, stallAfterMs: 60_000, browserFactory: factory })
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
    const pool = new BrowserPool({
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
    const pool = new BrowserPool({
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
