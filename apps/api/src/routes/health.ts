import type { PoolStats } from "@trawl/types"
import { Elysia } from "elysia"
import { HEADFUL_POOL_SIZE, POOL_SIZE, startTime } from "../config"
import { getPool } from "../deps"
import { type RuntimeMemory, readRuntimeMemory } from "../runtimeMemory"

export function healthRoute(
  getStats = () => getPool()?.getStats(),
  getMemory = (): RuntimeMemory | undefined => readRuntimeMemory(POOL_SIZE, HEADFUL_POOL_SIZE),
) {
  return new Elysia().get("/health", ({ set }) => {
    const stats = getStats()
    // `pool` is assigned before `await pool.init()` completes, so a non-null pool does
    // not mean any browser is warm — gate readiness on real capacity instead.
    //
    // `available + busy > 0` looks like the right test — a busy browser is still a live
    // browser — but it isn't. A request that hangs mid-solve never reaches the
    // orchestrator's `finally`, so it never calls release() and its browser stays `busy`
    // for the life of the process. `busy` therefore counts dead entries, and the pod can
    // report 200/"ok" indefinitely with zero usable browsers.
    //
    // `live` excludes both restarting entries (no browser attached) and entries whose
    // checkout has outlived the stall threshold, so it cannot be propped up by a wedge.
    // It still counts genuinely in-flight work, so a merely saturated pool won't flap.
    const ready = Boolean(stats && stats.live > 0)
    if (!ready) set.status = 503
    const memory = getMemory()
    return {
      status: ready ? "ok" : "starting",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      ...(memory ? { memory } : {}),
      pool:
        stats ??
        ({
          total: 0,
          busy: 0,
          available: 0,
          restarts: 0,
          avgRestarts: 0,
          stalled: 0,
          live: 0,
        } satisfies PoolStats),
    }
  })
}
