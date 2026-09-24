import { describe, expect, test } from "bun:test"
import type { PoolStats } from "@trawl/types"
import { healthRoute } from "./health"

const stats = (live: number): PoolStats => ({
  total: 1,
  busy: live ? 1 : 0,
  available: 0,
  restarts: 0,
  avgRestarts: 0,
  stalled: live ? 0 : 1,
  live,
})

describe("GET /health", () => {
  test("returns 200 while the pool has live capacity", async () => {
    const response = await healthRoute(
      () => stats(1),
      () => ({
        currentBytes: 10,
        limitBytes: 100,
        recommendedLimitBytes: 200,
        underProvisioned: true,
        oomEvents: 2,
        oomKills: 1,
      }),
    ).handle(new Request("http://localhost/health"))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "ok",
      pool: { live: 1 },
      memory: { underProvisioned: true, oomKills: 1 },
    })
  })

  test("returns 503 when no live capacity remains", async () => {
    const response = await healthRoute(() => stats(0)).handle(new Request("http://localhost/health"))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: "starting", pool: { live: 0 } })
  })

  test("returns 503 before the pool is available", async () => {
    const response = await healthRoute(() => undefined).handle(new Request("http://localhost/health"))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: "starting", pool: { total: 0 } })
  })
})
