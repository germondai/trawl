import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { SessionData } from "@trawl/types"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { capturePageScreenshot } from "../src/screenshot"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"

const PAGE_HTML = `<html><head><title>Ordinary Page</title></head><body>${"content ".repeat(20)}</body></html>`
const JPEG = Buffer.from("fake-jpeg-bytes")
const JPEG_BASE64 = JPEG.toString("base64")

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" }

const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

interface PageStub {
  screenshotCalls: Array<Record<string, unknown>>
  page: any
}

const makePage = (options: { failScreenshot?: boolean } = {}): PageStub => {
  const screenshotCalls: Array<Record<string, unknown>> = []
  const page = {
    url: () => "https://example.com/landed",
    title: async () => "Ordinary Page",
    content: async () => PAGE_HTML,
    goto: async () => {},
    on: () => {},
    mainFrame: () => ({}),
    frames: () => [],
    context: () => ({ cookies: async () => [] }),
    evaluate: async () => "test-agent",
    setExtraHTTPHeaders: async () => {},
    waitForLoadState: async () => {},
    close: async () => {},
    screenshot: async (opts: Record<string, unknown>) => {
      screenshotCalls.push(opts)
      if (options.failScreenshot) throw new Error("screenshot failed: target closed")
      return JPEG
    },
  }
  return { screenshotCalls, page }
}

const poolHandle = (page: unknown): BrowserHandle =>
  ({
    id: 1,
    lease: 1,
    context: { newPage: async () => page, addCookies: async () => {}, cookies: async () => [] },
    browser: {},
    fingerprint,
  }) satisfies BrowserHandle

const freshHandle = (page: unknown): BrowserHandle =>
  ({
    id: 2,
    lease: 1,
    context: {},
    browser: {
      newContext: async () => ({
        newPage: async () => page,
        addInitScript: async () => {},
        cookies: async () => [],
        close: async () => {},
      }),
    },
    fingerprint,
  }) satisfies BrowserHandle

describe("capturePageScreenshot", () => {
  test("returns base64 JPEG of the viewport, never a full-page capture", async () => {
    const { page, screenshotCalls } = makePage()

    expect(await capturePageScreenshot(page)).toBe(JPEG_BASE64)
    expect(screenshotCalls).toHaveLength(1)
    expect(screenshotCalls[0].type).toBe("jpeg")
    expect(screenshotCalls[0].fullPage).toBeUndefined()
    expect(screenshotCalls[0].timeout).toBeGreaterThan(0)
  })

  test("degrades to undefined when the page cannot be captured", async () => {
    const { page } = makePage({ failScreenshot: true })

    expect(await capturePageScreenshot(page)).toBeUndefined()
  })
})

describe("browser tiers", () => {
  test("Tier 2 returns a screenshot only when the request asks for one", async () => {
    const requested = makePage()
    const withShot = await runTier2(
      "https://example.com",
      poolHandle(requested.page),
      session,
      4_000,
      {},
      "GET",
      "",
      true,
    )
    expect(withShot.status).toBe("success")
    expect(withShot.screenshot).toBe(JPEG_BASE64)

    const untouched = makePage()
    const withoutShot = await runTier2("https://example.com", poolHandle(untouched.page), session, 4_000)
    expect(withoutShot.status).toBe("success")
    expect(withoutShot.screenshot).toBeUndefined()
    expect(untouched.screenshotCalls).toHaveLength(0)
  })

  test("Tier 3 returns a screenshot only when the request asks for one", async () => {
    const requested = makePage()
    const withShot = await runTier3(
      "https://example.com",
      freshHandle(requested.page),
      4_000,
      undefined,
      {},
      "GET",
      "",
      true,
    )
    expect(withShot.status).toBe("success")
    expect(withShot.screenshot).toBe(JPEG_BASE64)

    const untouched = makePage()
    const withoutShot = await runTier3("https://example.com", freshHandle(untouched.page), 4_000)
    expect(withoutShot.status).toBe("success")
    expect(withoutShot.screenshot).toBeUndefined()
    expect(untouched.screenshotCalls).toHaveLength(0)
  })

  test("Tier 4 returns a screenshot only when the request asks for one", async () => {
    const requested = makePage()
    const withShot = await runTier4(
      "https://example.com",
      freshHandle(requested.page),
      4_000,
      "http://proxy.example:8080",
      {},
      "GET",
      "",
      true,
    )
    expect(withShot.status).toBe("success")
    expect(withShot.screenshot).toBe(JPEG_BASE64)

    const untouched = makePage()
    const withoutShot = await runTier4(
      "https://example.com",
      freshHandle(untouched.page),
      4_000,
      "http://proxy.example:8080",
    )
    expect(withoutShot.status).toBe("success")
    expect(withoutShot.screenshot).toBeUndefined()
    expect(untouched.screenshotCalls).toHaveLength(0)
  })

  test("a failing screenshot still yields a successful scrape on every browser tier", async () => {
    const t2 = await runTier2(
      "https://example.com",
      poolHandle(makePage({ failScreenshot: true }).page),
      session,
      4_000,
      {},
      "GET",
      "",
      true,
    )
    expect(t2.status).toBe("success")
    expect(t2.html).toContain("Ordinary Page")
    expect(t2.screenshot).toBeUndefined()

    const t3 = await runTier3(
      "https://example.com",
      freshHandle(makePage({ failScreenshot: true }).page),
      4_000,
      undefined,
      {},
      "GET",
      "",
      true,
    )
    expect(t3.status).toBe("success")
    expect(t3.screenshot).toBeUndefined()

    const t4 = await runTier4(
      "https://example.com",
      freshHandle(makePage({ failScreenshot: true }).page),
      4_000,
      "http://proxy.example:8080",
      {},
      "GET",
      "",
      true,
    )
    expect(t4.status).toBe("success")
    expect(t4.screenshot).toBeUndefined()
  })
})

describe("orchestrator", () => {
  const depsFor = (page: unknown): OrchestratorDeps => ({
    acquireBrowser: async () => freshHandle(page),
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  })

  test("emits the tier's screenshot on the scrape result when requested", async () => {
    const { page } = makePage()

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 3, maxTimeout: 4_000, screenshot: true },
      depsFor(page),
    )

    expect(result.tier).toBe(3)
    expect(result.screenshot).toBe(JPEG_BASE64)
  })

  test("omits the screenshot by default", async () => {
    const { page, screenshotCalls } = makePage()

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 3, maxTimeout: 4_000 },
      depsFor(page),
    )

    expect(result.tier).toBe(3)
    expect(result.screenshot).toBeUndefined()
    expect(screenshotCalls).toHaveLength(0)
  })
})
