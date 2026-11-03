import type { PoolStats, StatsResponse } from "@trawl/types"
import { Elysia } from "elysia"
import { getHeadfulPool, getPool } from "../deps"

export function statsRoute(
  getMainStats = (): PoolStats | undefined => getPool()?.getStats(),
  getHeadfulStats = (): PoolStats | undefined => getHeadfulPool()?.getStats(),
) {
  return new Elysia().get("/stats", () => {
    const stats = getMainStats() ?? {
      total: 0,
      busy: 0,
      available: 0,
      restarts: 0,
      avgRestarts: 0,
      stalled: 0,
      live: 0,
    }
    // `null` means the optional pool is disabled.
    const headful = getHeadfulStats()
    return {
      browsers: stats.total,
      available: stats.available,
      busy: stats.busy,
      stalled: stats.stalled,
      live: stats.live,
      restarts: stats.restarts,
      queueDepth: stats.queueDepth ?? 0,
      longestBusyMs: stats.longestBusyMs ?? 0,
      draining: stats.draining ?? false,
      headful: headful
        ? {
            browsers: headful.total,
            available: headful.available,
            busy: headful.busy,
            stalled: headful.stalled,
            live: headful.live,
            restarts: headful.restarts,
            queueDepth: headful.queueDepth ?? 0,
            longestBusyMs: headful.longestBusyMs ?? 0,
            draining: headful.draining ?? false,
          }
        : null,
    } satisfies StatsResponse
  })
}
