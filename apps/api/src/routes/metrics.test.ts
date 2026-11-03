import { describe, expect, test } from "bun:test"
import type { PoolStats } from "@trawl/types"
import { MetricsStore } from "../metrics"
import { metricsRoute, renderMetrics } from "./metrics"

const stats = (over: Partial<PoolStats> = {}): PoolStats => ({
  total: 6,
  busy: 3,
  available: 3,
  restarts: 12,
  avgRestarts: 2,
  stalled: 0,
  live: 6,
  queueDepth: 0,
  acquired: 100,
  exhausted: 4,
  acquireWaitMsTotal: 5000,
  ...over,
})

const value = (body: string, name: string): number => {
  const line = body.split("\n").find((l) => l.startsWith(`${name} `))
  if (!line) throw new Error(`no sample for ${name}`)
  return Number(line.slice(name.length + 1))
}

describe("GET /metrics", () => {
  test("exports WAF counters without dashboard storage or target labels", async () => {
    const store = new MetricsStore(false)
    store.record({
      source: "native",
      url: "https://private.example/secret",
      statusCode: 200,
      durationMs: 10,
      waf: {
        engine: "wafmeow",
        version: "3.1.0",
        state: "complete",
        products: ['Provider "quoted"\nname'],
        durationMs: 2,
      },
    })
    const response = await metricsRoute(() => stats(), store).handle(new Request("http://localhost/metrics"))
    const body = await response.text()
    expect(body).toContain('trawl_waf_detections_total{state="complete"} 1')
    expect(body).toContain(
      'trawl_waf_provider_requests_total{provider="Provider \\"quoted\\"\\nname",outcome="success"} 1',
    )
    expect(body).toContain("trawl_waf_detection_duration_seconds_total 0.002")
    expect(body).not.toMatch(/private|secret|domain=/)
  })
  test("serves the Prometheus text exposition content type", async () => {
    const response = await metricsRoute(() => stats()).handle(new Request("http://localhost/metrics"))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8")
  })

  test("every sample carries a HELP and TYPE line", () => {
    const body = renderMetrics(stats())
    const samples = body.split("\n").filter((l) => l && !l.startsWith("#"))

    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      const name = sample.split(" ")[0]
      expect(body).toContain(`# HELP ${name} `)
      expect(body).toContain(`# TYPE ${name} `)
    }
  })

  test("utilization is busy over configured size", () => {
    expect(value(renderMetrics(stats({ total: 6, busy: 3 })), "trawl_pool_utilization_ratio")).toBe(0.5)
  })

  test("utilization is 0 rather than NaN before the pool has any slots", () => {
    const body = renderMetrics(stats({ total: 0, busy: 0 }))

    expect(value(body, "trawl_pool_utilization_ratio")).toBe(0)
    expect(body).not.toContain("NaN")
  })

  test("an uninitialized pool still publishes the full series set", () => {
    const body = renderMetrics(stats())
    const zeroed = renderMetrics(
      stats({ total: 0, busy: 0, available: 0, live: 0, acquired: 0, exhausted: 0, acquireWaitMsTotal: 0 }),
    )
    const names = (b: string) =>
      b
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split(" ")[0])

    expect(names(zeroed)).toEqual(names(body))
  })

  test("exposes queued callers as the saturation signal", () => {
    expect(value(renderMetrics(stats({ queueDepth: 7 })), "trawl_pool_waiting")).toBe(7)
  })

  test("exports checkout wait in seconds", () => {
    expect(value(renderMetrics(stats({ acquireWaitMsTotal: 1250 })), "trawl_pool_acquire_wait_seconds_total")).toBe(
      1.25,
    )
  })

  test("a pool without the optional counters publishes them as zero", () => {
    const body = renderMetrics({ total: 6, busy: 1, available: 5, restarts: 0, avgRestarts: 0, stalled: 0, live: 6 })

    expect(value(body, "trawl_pool_waiting")).toBe(0)
    expect(value(body, "trawl_pool_acquired_total")).toBe(0)
    expect(body).not.toContain("undefined")
  })

  test("falls back to a zeroed pool when the pool is not yet constructed", async () => {
    const response = await metricsRoute(() => undefined).handle(new Request("http://localhost/metrics"))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(value(body, "trawl_pool_size")).toBe(0)
    expect(value(body, "trawl_pool_waiting")).toBe(0)
  })
})
