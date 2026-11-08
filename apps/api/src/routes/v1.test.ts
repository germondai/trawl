import { describe, expect, spyOn, test } from "bun:test"
import { PoolExhaustedError } from "@trawl/browser"
import { type OrchestratorDeps, ScrapeError, type scrape } from "@trawl/tiers"
import type { Cookie, ScrapeRequest, ScrapeResult } from "@trawl/types"
import { MetricsStore } from "../metrics"
import { v1Route } from "./v1"

describe("POST /v1", () => {
  test("returns a FlareSolverr error envelope when an explicit proxy fails", async () => {
    const metricsStore = new MetricsStore()
    const app = v1Route({
      poolReady: () => true,
      orchestratorDeps: () => ({}) as OrchestratorDeps,
      runScrape: async () => {
        throw new ScrapeError("All tiers exhausted. Last failure: proxy-connection-failed", [
          { tier: 1, status: "error", durationMs: 1, reason: "proxy-connection-failed" },
        ])
      },
      metricsStore,
    })

    const response = await app.handle(
      new Request("http://localhost/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cmd: "request.get",
          url: "https://target.example",
          proxy: "http://proxy.example:8080",
        }),
      }),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      status: "error",
      message: "All tiers exhausted. Last failure: proxy-connection-failed",
      solution: { url: "https://target.example", status: 0, response: "" },
    })
    expect(metricsStore.snapshot().requests).toBe(1)
    metricsStore.close()
  })

  test("records commands rejected before scraping", async () => {
    const metricsStore = new MetricsStore()
    const app = v1Route({ poolReady: () => false, metricsStore })
    const send = (body: unknown) =>
      app.handle(
        new Request("http://localhost/v1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    expect((await send({ url: "https://target.example", cmd: "request.get" })).status).toBe(503)
    expect((await send({ url: "https://target.example", cmd: "unknown" })).status).toBe(400)
    expect((await send({ cmd: "request.get" })).status).toBe(400)
    expect(metricsStore.snapshot().requests).toBe(3)
    expect(metricsStore.snapshot().failures).toBe(3)
    metricsStore.close()
  })
})

describe("POST /v1 cookie handoff", () => {
  const cookie: Cookie = {
    name: "cf_clearance",
    value: "owned",
    domain: ".example.test",
    path: "/",
    expires: -1,
    secure: true,
    httpOnly: true,
  }
  const http: ScrapeResult = {
    url: "https://sub.example.test/items/1",
    html: "Owned content",
    cookies: [],
    userAgent: "http-agent",
    tier: 1,
    totalMs: 0,
    sessionCached: false,
    statusCode: 200,
    timings: [{ tier: 1, status: "success", durationMs: 0 }],
  }
  const setup = (runScrape: typeof scrape, defaultMaxTimeout = 1000) => {
    const metrics = new MetricsStore()
    const app = v1Route({
      cookieFallback: true,
      runScrape,
      poolReady: () => true,
      orchestratorDeps: () => ({ defaultMaxTimeout }) as OrchestratorDeps,
      metricsStore: metrics,
    })
    const send = (body: Record<string, unknown> = {}) =>
      app.handle(
        new Request("http://localhost/v1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmd: "request.get", url: http.url, ...body }),
        }),
      )
    return { send, metrics }
  }

  test.each(["https://prowlarr.servarr.com/v1/ping", "HTTPS://PROWLARR.SERVARR.COM:443/v1/ping"])(
    "accepts Prowlarr's public connectivity check without requiring cookies: %s",
    async (url) => {
      let attempts = 0
      const client = setup(async () => ({
        ...http,
        url,
        html: "Pong",
        tier: ++attempts === 1 ? 1 : 3,
      }))
      try {
        const response = await client.send({ url })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          status: "ok",
          solution: { status: 200, response: "Pong", cookies: [] },
        })
        expect(attempts).toBe(1)
        expect(client.metrics.snapshot()).toMatchObject({ requests: 1, failures: 0 })
      } finally {
        client.metrics.close()
      }
    },
  )

  test.each([
    { url: "https://other.test/v1/ping" },
    { url: "https://prowlarr.servarr.com.other.test/v1/ping" },
    { url: "http://prowlarr.servarr.com/v1/ping" },
    { url: "https://prowlarr.servarr.com:444/v1/ping" },
    { url: "https://prowlarr.servarr.com/v1/ping-other" },
    { url: "https://prowlarr.servarr.com/v1/ping?indexer=1" },
    { url: "https://prowlarr.servarr.com/v1/ping", html: "Verification required" },
    { url: "https://prowlarr.servarr.com/v1/ping", effectiveUrl: "https://other.test/indexer" },
    { url: "https://other.test/indexer", effectiveUrl: "https://prowlarr.servarr.com/v1/ping" },
  ])("keeps cookie handoff required outside the exact public ping: %j", async ({ url, effectiveUrl, html }) => {
    let attempts = 0
    const client = setup(async () => ({
      ...http,
      url: effectiveUrl ?? url,
      html: html ?? "Pong",
      tier: ++attempts === 1 ? 1 : 3,
    }))
    try {
      const response = await client.send({ url })
      expect(response.status).toBe(500)
      expect((await response.json()).message).toContain("no usable cookies")
      expect(attempts).toBe(2)
      expect(client.metrics.snapshot()).toMatchObject({ requests: 1, failures: 1 })
    } finally {
      client.metrics.close()
    }
  })

  test.each([true, false])("shares the original %s explicit timeout with its browser fallback", async (explicit) => {
    let now = 1000
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    const requests: ScrapeRequest[] = []
    const client = setup(async (req) => {
      requests.push(req)
      now += requests.length === 1 ? 750 : 100
      return requests.length === 1
        ? http
        : {
            ...http,
            tier: 3,
            cookies: [cookie],
            userAgent: "browser-agent",
            timings: [{ tier: 3, status: "success", durationMs: 100 }],
          }
    })
    try {
      const response = await client.send(explicit ? { maxTimeout: 1000 } : {})
      expect(response.status).toBe(200)
      expect(requests[1]?.maxTimeout).toBe(250)
      expect((await response.json()).solution.userAgent).toBe("browser-agent")
      expect(client.metrics.snapshot()).toMatchObject({ requests: 1, failures: 0 })
    } finally {
      clock.mockRestore()
      client.metrics.close()
    }
  })

  test("does not start a browser after the original deadline expires", async () => {
    let now = 1000
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    let attempts = 0
    const client = setup(async () => {
      attempts++
      now += 1000
      return http
    })
    try {
      const response = await client.send()
      expect(response.status).toBe(500)
      expect((await response.json()).message).toContain("deadline exceeded")
      expect(attempts).toBe(1)
      expect(client.metrics.snapshot()).toMatchObject({ requests: 1, failures: 1 })
    } finally {
      clock.mockRestore()
      client.metrics.close()
    }
  })

  test.each([
    { name: "expired", changes: { expires: 1 } },
    { name: "another host", changes: { domain: ".other.test" } },
    { name: "another path", changes: { path: "/items-other" } },
    { name: "empty value", changes: { value: "" } },
    { name: "secure cookie on HTTP", changes: {}, url: "http://sub.example.test/items/1" },
  ])("rejects unusable cookies: $name", async ({ changes, url }) => {
    let attempts = 0
    const client = setup(async () => ({
      ...http,
      tier: ++attempts === 1 ? 1 : 3,
      cookies: [{ ...cookie, ...changes }],
    }))
    try {
      const response = await client.send(url ? { url } : {})
      expect(response.status).toBe(500)
      expect((await response.json()).message).toContain("no usable cookies")
      expect(attempts).toBe(2)
    } finally {
      client.metrics.close()
    }
  })

  test("keeps usable HTTP cookies on the fast path", async () => {
    let attempts = 0
    const client = setup(async () => {
      attempts++
      return { ...http, cookies: [cookie] }
    })
    try {
      const response = await client.send()
      expect(response.status).toBe(200)
      expect(attempts).toBe(1)
    } finally {
      client.metrics.close()
    }
  })

  test("preserves pool saturation errors during browser fallback", async () => {
    let attempts = 0
    const client = setup(async () => {
      if (++attempts === 1) return http
      throw new PoolExhaustedError()
    })
    try {
      const response = await client.send()
      expect(response.status).toBe(429)
      expect((await response.json()).message).toContain("pool exhausted")
      expect(client.metrics.snapshot()).toMatchObject({ requests: 1, failures: 1 })
    } finally {
      client.metrics.close()
    }
  })
})
