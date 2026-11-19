import { expect, test } from "bun:test"
import { usageReporter } from "@trawl/telemetry"
import { createCollector } from "../src/collector"

const token = "owned-fixture-admin-token-at-least-32-characters"
test("actual collector accepts only bounded anonymous fields and exposes aggregates only to its admin", async () => {
  const collector = createCollector({ database: ":memory:", adminToken: token })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 16384,
    fetch: (request) => collector.handle(request, "owned-peer"),
  })
  const transport: typeof fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => fetch(new URL("/v1/events", server.url), init),
    { preconnect: fetch.preconnect },
  ) as typeof fetch
  const reporter = usageReporter({
    enabled: true,
    endpoint: "https://collector.fixture.com/v1/events",
    version: "1.11.1",
    fetch: transport,
  })
  try {
    reporter.record({
      url: "https://public.fixture.com/path?secret=private",
      success: true,
      challenge: "turnstile",
      durationMs: 1234,
    })
    reporter.record({
      url: "https://public.fixture.com/other",
      success: true,
      challenge: "turnstile",
      durationMs: 1500,
    })
    await reporter.flush()
    expect((await fetch(new URL("/v1/stats", server.url))).status).toBe(401)
    const stats = await (
      await fetch(new URL("/v1/stats", server.url), { headers: { authorization: `Bearer ${token}` } })
    ).json()
    expect(stats.rows).toHaveLength(1)
    expect(stats.rows[0]).toMatchObject({
      domain: "public.fixture.com",
      challenge: "turnstile",
      success: 1,
      requests: 2,
    })
    expect(JSON.stringify(stats)).not.toMatch(/secret|private|owned-peer/)
    const event = {
      domain: "public.fixture.com",
      challenge: "unknown",
      success: false,
      durationMs: 10,
      version: "1.11.1",
    }
    for (const input of [
      { events: [{ ...event, payload: "secret" }] },
      { events: Array(21).fill(event) },
      { events: [{ ...event, domain: "127.0.0.1" }] },
    ])
      expect(
        (
          await collector.handle(
            new Request("http://collector/v1/events", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            }),
          )
        ).status,
      ).toBe(400)
    expect(
      (
        await collector.handle(
          new Request("http://collector/v1/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: " ".repeat(16385),
          }),
        )
      ).status,
    ).toBe(413)
  } finally {
    reporter.close()
    server.stop(true)
    collector.close()
  }
})
test("collector bounds peer admission and expires aggregates", async () => {
  let now = Date.now()
  const collector = createCollector({ database: ":memory:", adminToken: token, now: () => now })
  const request = () =>
    new Request("http://collector/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { domain: "public.fixture.com", challenge: "unknown", success: true, durationMs: 10, version: "1.11.1" },
        ],
      }),
    })
  try {
    for (let i = 0; i < 120; i++) expect((await collector.handle(request(), "owned-peer")).status).toBe(202)
    expect((await collector.handle(request(), "owned-peer")).status).toBe(429)
    now += 31 * 86400000
    const expired = await (
      await collector.handle(
        new Request("http://collector/v1/stats", { headers: { authorization: `Bearer ${token}` } }),
      )
    ).json()
    expect(expired.rows).toEqual([])
    expect((await collector.handle(request(), "new-peer")).status).toBe(202)
    const stats = await (
      await collector.handle(
        new Request("http://collector/v1/stats", { headers: { authorization: `Bearer ${token}` } }),
      )
    ).json()
    expect(stats.rows).toHaveLength(1)
    expect(stats.rows[0].requests).toBe(1)
  } finally {
    collector.close()
  }
})
