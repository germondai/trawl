import { Database } from "bun:sqlite"
import { describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ScrapeError } from "@trawl/tiers"
import { MetricsStore } from "./metrics"

test("dashboard response maximum covers the selected range beyond its recent-event preview", () => {
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now - 2 * 60 * 60000)
  const store = new MetricsStore(true, ":memory:", true)
  try {
    store.record({ source: "native", url: "https://owned.example", durationMs: 100000, statusCode: 200 })
    clock.mockReturnValue(now)
    for (let index = 0; index < 120; index++)
      store.record({
        source: "native",
        url: "https://owned.example",
        durationMs: index === 0 ? 50000 : 10,
        statusCode: 200,
      })
    const snapshot = store.snapshot(60)
    expect(snapshot.maximumMs).toBe(50000)
    expect(snapshot.averageMs).toBe(Math.round((50000 + 1190) / 120))
    expect(snapshot.recentEvents.some((entry) => entry.durationMs === 50000)).toBe(false)
    expect(store.snapshot(1440).maximumMs).toBe(100000)
  } finally {
    clock.mockRestore()
    store.close()
  }
})

test("active-list overflow is bounded and clears after every in-flight observation finishes", () => {
  const store = new MetricsStore(true, ":memory:", true)
  const finishes = Array.from({ length: 300 }, (_, index) =>
    store.startRequest(`request-${index}`, "native", "https://owned.example"),
  )
  expect(store.history().active).toHaveLength(256)
  expect(store.history().activeTruncated).toBe(true)
  for (const finish of finishes) {
    finish?.()
    finish?.()
  }
  expect(store.history().active).toEqual([])
  expect(store.history().activeTruncated).toBe(false)
  store.close()
})

test("large WAF details remain available in details without overflowing lifecycle or history pages", () => {
  const store = new MetricsStore(true, ":memory:", true)
  const waf = {
    engine: "wafmeow" as const,
    version: "3.1.0",
    state: "complete" as const,
    products: Array.from({ length: 256 }, (_, index) => `${index}-`.padEnd(256, "x")),
  }
  store.startRequest("large-waf", "native", "https://owned.example")
  store.record({
    requestId: "large-waf",
    source: "native",
    url: "https://owned.example",
    durationMs: 1,
    statusCode: 200,
    waf,
  })
  const entries = store.events.snapshot().entries
  expect(entries).toHaveLength(2)
  expect(entries[1]?.data.type).toBe("completed")
  expect(JSON.stringify(entries).length).toBeLessThan(1024)
  expect(store.history().entries[0]?.waf).toBeUndefined()
  expect(store.request("large-waf")?.waf?.products).toHaveLength(256)
  expect(store.history().activeTruncated).toBe(false)
  store.close()
})

const waf = {
  engine: "wafmeow" as const,
  version: "3.1.0",
  state: "complete" as const,
  products: ["Cloudflare", "Cloudflare"],
  matches: [{ product: "Cloudflare", schema: 1, fingerprints: [{ fingerprint: 1, evidence: 0 }] }],
  incompleteProducts: ["Body provider"],
  diagnostics: [{ code: "body_truncated" as const, evidence: 0 }],
  detailsTruncated: true,
  sourceTier: 1 as const,
  durationMs: 2.5,
}

describe("local metrics", () => {
  test("includes the first partial bucket in the selected range", () => {
    const now = Date.parse("2026-11-11T12:34:30Z")
    const clock = spyOn(Date, "now").mockReturnValue(now)
    const store = new MetricsStore()
    try {
      clock.mockReturnValue(now - 60 * 60_000 + 15_000)
      store.record({ source: "native", url: "https://example.test/", statusCode: 200, durationMs: 1 })
      clock.mockReturnValue(now)
      store.record({ source: "native", url: "https://example.test/", statusCode: 200, durationMs: 2 })
      const snapshot = store.snapshot(60)
      expect(snapshot.requests).toBe(2)
      expect(snapshot.timeline[0]).toMatchObject({ minute: "2026-11-11T11:34:00.000Z", requests: 1 })
      expect(snapshot.timeline.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(snapshot.requests)
      expect(snapshot.timeline.at(-1)?.requests).toBe(1)
    } finally {
      store.close()
      clock.mockRestore()
    }
  })

  test("keeps bounded WAF counters without enabling history storage", () => {
    const store = new MetricsStore(false)
    store.record({ source: "native", url: "https://example.com/private", durationMs: 4, statusCode: 200, waf })
    store.record({
      source: "native",
      url: "https://example.com/private",
      durationMs: 5,
      error: new Error("blocked"),
      waf: { ...waf, state: "unavailable", products: [], reason: "busy" },
    })
    expect(store.snapshot().requests).toBe(0)
    expect(store.wafTotals()).toEqual({
      states: { complete: 1, incomplete: 0, unavailable: 1 },
      unavailable: { busy: 1 },
      durationMs: 5,
      timed: 2,
      providers: [{ product: "Cloudflare", requests: 1, failures: 0 }],
    })
    for (let index = 0; index < 300; index++)
      store.record({
        source: "native",
        url: "https://example.com",
        durationMs: 1,
        statusCode: 200,
        waf: { ...waf, products: [`provider-${index}`] },
      })
    expect(store.wafTotals().providers).toHaveLength(256)
  })

  test("retains provider attribution for success and failure without raw evidence", () => {
    const store = new MetricsStore()
    const observedWaf = {
      ...waf,
      html: "private-html",
      matches: [
        {
          ...waf.matches[0],
          value: "private-header",
          fingerprints: [{ ...waf.matches[0]?.fingerprints[0], value: "private-cookie" }],
        },
      ],
      diagnostics: [{ ...waf.diagnostics[0], message: "private-url" }],
    }
    store.record({
      source: "native",
      url: "https://example.com",
      statusCode: 200,
      durationMs: 10,
      waf: observedWaf,
    })
    const error = new ScrapeError("private-error", [{ tier: 1, status: "blocked", durationMs: 1 }])
    error.waf = { ...waf, state: "incomplete" }
    store.record({ source: "flaresolverr", url: "https://example.com", durationMs: 20, error })
    const snapshot = store.snapshot()
    expect(snapshot.waf).toMatchObject({
      observations: 2,
      states: { complete: 1, incomplete: 1, unavailable: 0 },
      averageMs: 2.5,
      providers: [{ product: "Cloudflare", requests: 2, failures: 1 }],
    })
    expect(snapshot.recentFailures[0]?.waf).toMatchObject({ products: ["Cloudflare"], sourceTier: 1 })
    expect(snapshot.recentEvents[1]?.waf).toMatchObject({ matches: waf.matches, diagnostics: waf.diagnostics })
    expect(JSON.stringify(snapshot)).not.toContain("private")
    store.close()
  })

  test("migrates existing history without dropping events and persists WAF metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "trawl-waf-migration-"))
    const path = join(dir, "events.sqlite")
    try {
      const old = new Database(path)
      old.run(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER, domain TEXT, source TEXT, duration_ms INTEGER, success INTEGER, tier INTEGER, tier_status TEXT, status_code INTEGER, category TEXT, severity TEXT)",
      )
      old
        .query("INSERT INTO events(at,domain,source,duration_ms,success,tier,status_code) VALUES(?,?,?,?,?,?,?)")
        .run(Date.now(), "old.example", "native", 1, 1, 1, 200)
      old.close()
      const first = new MetricsStore(true, path)
      first.record({ source: "native", url: "https://new.example", statusCode: 200, durationMs: 4, waf })
      first.close()
      const reopened = new MetricsStore(true, path)
      expect(reopened.snapshot().requests).toBe(2)
      expect(reopened.snapshot().waf.providers).toEqual([{ product: "Cloudflare", requests: 1, failures: 0 }])
      expect(reopened.snapshot().recentEvents[0]?.waf).toMatchObject({ products: ["Cloudflare"] })
      expect(reopened.snapshot().recentEvents[0]?.waf).toMatchObject({
        matches: waf.matches,
        incompleteProducts: waf.incompleteProducts,
        diagnostics: waf.diagnostics,
        detailsTruncated: true,
      })
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("keeps collection off when the dashboard is disabled", () => {
    const store = new MetricsStore(false)
    store.recordTierZeroAttempt()
    store.record({ source: "native", url: "https://example.com", statusCode: 200, durationMs: 1, tier: 1 })
    expect(store.snapshot().requests).toBe(0)
    expect(store.snapshot().byTier[0].attempts).toBe(0)
  })

  test("counts requests and tier outcomes without retaining URL secrets or raw errors", () => {
    const store = new MetricsStore()
    store.record({
      source: "mcp",
      url: "https://user:password@example.com/private/token?key=secret",
      durationMs: 20,
      tier: 3,
      statusCode: 200,
      attempts: [
        { tier: 1, status: "blocked", durationMs: 4, reason: "secret" },
        { tier: 2, status: "skipped", durationMs: 0 },
        { tier: 3, status: "success", durationMs: 10 },
      ],
    })
    store.record({
      source: "native",
      url: "https://example.com/another?token=secret",
      durationMs: 30,
      error: new ScrapeError("secret URL https://example.com/private", [
        { tier: 1, status: "blocked", durationMs: 8, reason: "secret" },
      ]),
    })

    const snapshot = store.snapshot()
    expect(snapshot.requests).toBe(2)
    expect(snapshot.successes).toBe(1)
    expect(snapshot.failures).toBe(1)
    expect(snapshot.averageMs).toBe(25)
    expect(snapshot.lastHour.at(-1)).toMatchObject({ requests: 2, failures: 1 })
    expect(snapshot.timeline.at(-1)).toMatchObject({
      averageMs: 25,
      sources: { mcp: 1, native: 1 },
      tiers: { 1: 1, 3: 1 },
    })
    expect(snapshot.byTier[1]).toEqual({ attempts: 2, successes: 0 })
    expect(snapshot.byTier[2]).toEqual({ attempts: 0, successes: 0 })
    expect(snapshot.byTier[3]).toEqual({ attempts: 1, successes: 1 })
    expect(snapshot.byFailure.blocked).toBe(1)
    expect(snapshot.domains[0]).toEqual({ domain: "example.com", requests: 2, failures: 1 })
    expect(snapshot.recentFailures[0]?.severity).toBe("warning")
    expect(snapshot.recentFailures[0]).toMatchObject({ tier: 1, tierStatus: "blocked", statusCode: null })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|password|private|token|reason/)
  })

  test("counts direct proxy responses and bounds retained domains and failures", () => {
    const store = new MetricsStore()
    store.recordTierZeroAttempt()
    store.record({ source: "proxy", url: "https://ok.example", tier: 0, statusCode: 200, durationMs: 2 })
    for (let index = 0; index < 120; index++) {
      store.record({
        source: "proxy",
        url: `https://site-${index}.example/path`,
        tier: 0,
        statusCode: 503,
        durationMs: 3,
      })
    }
    const snapshot = store.snapshot()
    expect(snapshot.requests).toBe(121)
    expect(snapshot.byTier[0]).toEqual({ attempts: 1, successes: 1 })
    expect(snapshot.byFailure.http).toBe(120)
    expect(snapshot.bySeverity.error).toBe(120)
    expect(snapshot.recentFailures[0]).toMatchObject({ tier: 0, tierStatus: null, statusCode: 503 })
    expect(snapshot.recentFailures).toHaveLength(50)
    expect(snapshot.lastHour).toHaveLength(61)
    expect(snapshot.lastHour[0]?.requests).toBe(0)
    expect(snapshot.domains).toHaveLength(20)
    expect(snapshot.domains.some((entry) => entry.domain === "ok.example")).toBe(false)
  })

  test("persists real events across reopen, keeps only hostnames, and filters time ranges", () => {
    const dir = mkdtempSync(join(tmpdir(), "trawl-metrics-"))
    const path = join(dir, "events.sqlite")
    try {
      const first = new MetricsStore(true, path)
      first.record({
        source: "mcp",
        url: "https://user:password@history.example/private?token=secret",
        durationMs: 17,
        tier: 2,
        statusCode: 200,
      })
      first.close()
      const second = new MetricsStore(true, path)
      const snapshot = second.snapshot(1440)
      expect(snapshot.requests).toBe(1)
      expect(snapshot.recentEvents[0]).toMatchObject({
        domain: "history.example",
        source: "mcp",
        durationMs: 17,
        success: true,
      })
      expect(snapshot.timeline.reduce((sum, point) => sum + point.requests, 0)).toBe(1)
      expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|password/)
      second.close()
      expect(readFileSync(path).toString()).not.toMatch(/private|secret|password/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
test("client request IDs cannot replace active, retained or truncated observations", () => {
  const store = new MetricsStore(true, ":memory:", true)
  const id = "10000000-0000-4000-8000-000000000000"
  try {
    expect(store.acceptRequestId(id)).toBe(id)
    expect(store.acceptRequestId("not-a-uuid")).toBeUndefined()
    const finish = store.startRequest(id, "native", "https://owned.fixture")
    expect(store.acceptRequestId(id)).toBeUndefined()
    finish?.()
    store.record({
      requestId: id,
      source: "native",
      url: "https://owned.fixture",
      durationMs: 1,
      tier: 1,
      statusCode: 200,
    })
    expect(store.acceptRequestId(id)).toBeUndefined()
    const finishes = Array.from({ length: 257 }, (_, index) =>
      store.startRequest(`overflow-${index}`, "native", "https://owned.fixture"),
    )
    finishes[0]?.()
    finishes[1]?.()
    expect(store.acceptRequestId("20000000-0000-4000-8000-000000000000")).toBeUndefined()
    for (const release of finishes) release?.()
    expect(store.acceptRequestId("20000000-0000-4000-8000-000000000000")).toBe("20000000-0000-4000-8000-000000000000")
  } finally {
    store.close()
  }
})
