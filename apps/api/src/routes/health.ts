import type { PoolStats } from "@trawl/types"
import { Elysia } from "elysia"
import { startTime } from "../config"
import { getPool } from "../deps"

export function healthRoute() {
  return new Elysia().get("/health", ({ set }) => {
    const pool = getPool()
    if (!pool) set.status = 503
    return {
      status: pool ? "ok" : "starting",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pool:
        pool?.getStats() ??
        ({
          total: 0,
          busy: 0,
          available: 0,
          restarts: 0,
          avgRestarts: 0,
        } satisfies PoolStats),
    }
  })
}
