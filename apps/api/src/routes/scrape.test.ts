import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { BrowserSessions, type OrchestratorDeps } from "@trawl/tiers"
import type { SessionData } from "@trawl/types"
import { MetricsStore } from "../metrics"
import { scrapeRoute } from "./scrape"

const WALL_HTML = `<html><head><title>Access denied</title></head><body><h1>403</h1>${"blocked ".repeat(40)}</body></html>`
const JPEG_BASE64 = Buffer.from("fake-jpeg-bytes").toString("base64")

const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

const mainFrame = {}
const wallPage = {
  url: () => "https://example.com/blocked",
  title: async () => "Access denied",
  content: async () => WALL_HTML,
  goto: async () => {},
  on: (event: string, handler: (response: unknown) => void) => {
    if (event !== "response") return
    handler({
      url: () => "https://example.com/blocked",
      status: () => 403,
      headers: () => ({}),
      body: async () => Buffer.from(WALL_HTML),
      request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
    })
  },
  off: () => {},
  once: () => {},
  mainFrame: () => mainFrame,
  frames: () => [],
  context: () => ({ cookies: async () => [] }),
  evaluate: async () => "test-agent",
  setExtraHTTPHeaders: async () => {},
  waitForLoadState: async () => {},
  close: async () => {},
  screenshot: async () => Buffer.from("fake-jpeg-bytes"),
}

const blockedDeps = (): OrchestratorDeps => ({
  acquireBrowser: async () =>
    ({
      id: 1,
      lease: 1,
      headful: false,
      context: { newPage: async () => wallPage, addCookies: async () => {}, cookies: async () => [] },
      browser: {},
      fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }) satisfies BrowserHandle,
  releaseBrowser: () => {},
  loadSession: async () => session,
  saveSession: async () => {},
  invalidateSession: async () => {},
})

const post = (body: unknown) =>
  scrapeRoute(blockedDeps, () => ({})).handle(
    new Request("http://localhost/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

const blockedRequest = { url: "https://example.com", skipHttp: true, maxTier: 2, maxTimeout: 4_000 }

describe("POST /scrape on a blocked outcome", () => {
  test("returns requested WAF attribution without exposing wall evidence", async () => {
    const waf = {
      engine: "wafmeow" as const,
      version: "3.1.0",
      state: "complete" as const,
      products: ["Example WAF"],
      matches: [{ product: "Example WAF", schema: 1, fingerprints: [{ fingerprint: 1, evidence: 0 }] }],
    }
    const app = scrapeRoute(
      () => ({ ...blockedDeps(), detectWaf: async () => waf }),
      () => ({}),
    )
    const response = await app.handle(
      new Request("http://localhost/scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...blockedRequest, detectWaf: true }),
      }),
    )
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.waf).toEqual({ ...waf, sourceTier: 2 })
    expect(body.blockedEvidence).toBeUndefined()
  })
  test("records requests rejected before the scraper starts", async () => {
    const store = new MetricsStore()
    const app = scrapeRoute(blockedDeps, () => null, store)
    const send = (body: unknown) =>
      app.handle(
        new Request("http://localhost/scrape", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    expect((await send({ url: "https://target.example" })).status).toBe(503)
    expect((await send({ url: "" })).status).toBe(400)
    const snapshot = store.snapshot()
    expect(snapshot.requests).toBe(2)
    expect(snapshot.failures).toBe(2)
    expect(snapshot.recentEvents[0]?.domain).toBe("unknown")
    expect(snapshot.recentEvents[1]?.domain).toBe("target.example")
    store.close()
  })
  test("still answers 500 with the per-tier attempt history", async () => {
    const response = await post(blockedRequest)

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toContain("Max tier reached without success")
    expect(body.timings).toEqual([{ tier: 2, status: "blocked", durationMs: expect.any(Number), reason: "http-403" }])
    expect(body.blockedEvidence).toBeUndefined()
  })

  test("carries the challenge wall when the request asked for it", async () => {
    const response = await post({ ...blockedRequest, blockedEvidence: true, screenshot: true })

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.timings[0].reason).toBe("http-403")
    expect(body.blockedEvidence).toMatchObject({
      tier: 2,
      status: "blocked",
      reason: "http-403",
      url: "https://example.com/blocked",
      statusCode: 403,
      screenshot: JPEG_BASE64,
    })
    expect(body.blockedEvidence.html).toContain("Access denied")
  })

  test("omits the image when only the markup was asked for", async () => {
    const response = await post({ ...blockedRequest, blockedEvidence: true })

    const body = await response.json()
    expect(body.blockedEvidence.html).toContain("Access denied")
    expect(body.blockedEvidence.screenshot).toBeUndefined()
  })
})

describe("POST /sessions/:id/scrape", () => {
  const send = (app: ReturnType<typeof scrapeRoute>, path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )

  test("uses the same session lookup and scrape metrics as /scrape", async () => {
    const store = new MetricsStore()
    const sessions = new BrowserSessions({
      acquireBrowser: async () => {
        throw new Error("Missing sessions must not acquire a browser")
      },
      releaseBrowser: () => {},
    })
    const app = scrapeRoute(
      () => ({ ...blockedDeps(), sessions }),
      () => true,
      store,
    )
    const body = { url: "https://target.example" }
    try {
      const legacy = await send(app, "/scrape", { ...body, sessionId: "account" })
      expect(legacy.status).toBe(404)
      const expected = await legacy.json()
      for (const input of [body, { ...body, sessionId: "account" }]) {
        const result = await send(app, "/sessions/account/scrape", input)
        expect(result.status).toBe(404)
        expect(await result.json()).toEqual(expected)
      }
      const snapshot = store.snapshot()
      expect(snapshot.requests).toBe(3)
      expect(snapshot.failures).toBe(3)
      expect(snapshot.recentEvents.every((event) => event.source === "native")).toBe(true)
    } finally {
      await sessions.shutdown()
      store.close()
    }
  })

  test("validates the body and path ID, rejects conflicting IDs and preserves pool readiness errors", async () => {
    const store = new MetricsStore()
    const app = scrapeRoute(blockedDeps, () => null, store)
    const url = "https://target.example"
    try {
      for (const body of [null, [], {}, { url: "" }, { url, screenshot: 1 }, { url, sessionId: "other" }]) {
        expect((await send(app, "/sessions/account/scrape", body)).status).toBe(400)
      }
      expect((await send(app, "/sessions/invalid.id/scrape", { url })).status).toBe(400)
      const unavailable = await send(app, "/sessions/account/scrape", { url })
      expect(unavailable.status).toBe(503)
      expect(await unavailable.json()).toEqual({ error: "Browser pool initializing, retry in a few seconds" })
      expect(store.snapshot().requests).toBe(8)
    } finally {
      store.close()
    }
  })
})
