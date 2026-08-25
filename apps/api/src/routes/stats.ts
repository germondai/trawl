import { Elysia } from "elysia"
import { getHeadfulPool, getPool } from "../deps"

export function statsRoute() {
  return new Elysia().get("/stats", () => {
    const stats = getPool()?.getStats() ?? {
      total: 0,
      busy: 0,
      available: 0,
      restarts: 0,
      avgRestarts: 0,
      stalled: 0,
      live: 0,
    }
    // `browsers` is the configured size, so the sub-pool reads `live: 0` with a non-zero
    // `browsers` until the first DataDome escalation warms it. `null` means it is disabled.
    const headful = getHeadfulPool()?.getStats()
    return {
      browsers: stats.total,
      available: stats.available,
      busy: stats.busy,
      stalled: stats.stalled,
      live: stats.live,
      restarts: stats.restarts,
      queueDepth: 0,
      headful: headful
        ? {
            browsers: headful.total,
            available: headful.available,
            busy: headful.busy,
            stalled: headful.stalled,
            live: headful.live,
            restarts: headful.restarts,
          }
        : null,
    }
  })
}
