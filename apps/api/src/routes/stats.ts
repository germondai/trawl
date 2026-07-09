import { Elysia } from "elysia"
import { getPool } from "../deps"

export function statsRoute() {
  return new Elysia().get("/stats", () => {
    const stats = getPool()?.getStats() ?? {
      total: 0,
      busy: 0,
      available: 0,
      restarts: 0,
      avgRestarts: 0,
    }
    return {
      browsers: stats.total,
      available: stats.available,
      busy: stats.busy,
      restarts: stats.restarts,
      queueDepth: 0,
    }
  })
}
