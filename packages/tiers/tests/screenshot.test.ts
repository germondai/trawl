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

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64" as const, locale: "en-US", timezone: "UTC" }

const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

interface PageStub {
  screenshotCalls: Array<Record<string, unknown>>
  selectorCalls: string[]
  routePatterns: string[]
  page: any
}

const makePage = (options: { failScreenshot?: boolean; image?: Buffer } = {}): PageStub => {
  const screenshotCalls: Array<Record<string, unknown>> = []
  const selectorCalls: string[] = []
  const routePatterns: string[] = []
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
    route: async (pattern: string) => {
      routePatterns.push(pattern)
    },
    waitForLoadState: async () => {},
    waitForSelector: async (selector: string) => {
      selectorCalls.push(selector)
    },
    close: async () => {},
    screenshot: async (opts: Record<string, unknown>) => {
      screenshotCalls.push(opts)
      if (options.failScreenshot) throw new Error("screenshot failed: target closed")
      return options.image ?? JPEG
    },
  }
  return { screenshotCalls, selectorCalls, routePatterns, page }
}

const poolHandle = (page: unknown): BrowserHandle =>
  ({
    id: 1,
    headful: false,
    lease: 1,
    context: { newPage: async () => page, addCookies: async () => {}, cookies: async () => [] },
    browser: {},
    fingerprint,
  }) satisfies BrowserHandle

const freshHandle = (page: unknown): BrowserHandle =>
  ({
    id: 2,
    headful: false,
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

  test("captures a bounded full page after a requested selector appears", async () => {
    const { page, screenshotCalls, selectorCalls } = makePage()
    page.evaluate = async () => ({ width: 1920, height: 2400 })

    expect(await capturePageScreenshot(page, 4_000, { fullPage: true, waitForSelector: ".loaded" })).toBe(JPEG_BASE64)
    expect(selectorCalls).toEqual([".loaded"])
    expect(screenshotCalls[0].fullPage).toBe(true)
  })

  test("refuses an oversized full-page canvas before capturing", async () => {
    const { page, screenshotCalls } = makePage()
    page.evaluate = async () => ({ width: 1920, height: 100_000 })

    expect(await capturePageScreenshot(page, 4_000, { fullPage: true })).toBeUndefined()
    expect(screenshotCalls).toHaveLength(0)
  })

  test("captures only the first visible matching element", async () => {
    const { page, screenshotCalls, selectorCalls } = makePage()
    const elementCalls: Array<Record<string, unknown>> = []
    page.locator = (selector: string) => {
      expect(selector).toBe(".chart")
      return {
        filter: (options: { visible: boolean }) => {
          expect(options.visible).toBe(true)
          return {
            first: () => ({
              boundingBox: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
              screenshot: async (options: Record<string, unknown>) => {
                elementCalls.push(options)
                return JPEG
              },
            }),
          }
        },
      }
    }

    expect(await capturePageScreenshot(page, 4_000, { selector: ".chart" })).toBe(JPEG_BASE64)
    expect(selectorCalls).toEqual([".chart"])
    expect(elementCalls[0]).toMatchObject({ type: "jpeg", quality: 60 })
    expect(screenshotCalls).toHaveLength(0)
  })

  test("rejects an oversized element before taking its screenshot", async () => {
    const { page } = makePage()
    let captured = false
    page.locator = () => ({
      filter: () => ({
        first: () => ({
          boundingBox: async () => ({ x: 0, y: 0, width: 1920, height: 10_000 }),
          screenshot: async () => {
            captured = true
            return JPEG
          },
        }),
      }),
    })

    expect(await capturePageScreenshot(page, 4_000, { selector: ".page" })).toBeUndefined()
    expect(captured).toBeFalse()
  })

  test("bounds page dimension checks by the remaining request budget", async () => {
    const { page } = makePage()
    page.evaluate = async () => new Promise(() => {})
    const start = performance.now()

    expect(await capturePageScreenshot(page, 20, { fullPage: true, settle: false })).toBeUndefined()
    expect(performance.now() - start).toBeLessThan(500)
  })

  test("drops screenshots that exceed the 4 MB limit", async () => {
    const { page } = makePage({ image: Buffer.alloc(4_000_001) })

    expect(await capturePageScreenshot(page)).toBeUndefined()
  })

  test("does no capture work when the request budget is exhausted", async () => {
    const { page, screenshotCalls } = makePage()

    expect(await capturePageScreenshot(page, 0)).toBeUndefined()
    expect(screenshotCalls).toHaveLength(0)
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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

  test("allows Tier 1 to succeed without producing or forcing a screenshot", async () => {
    const originalFetch = globalThis.fetch
    let browserAcquired = false
    globalThis.fetch = (async () =>
      new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch

    try {
      const result = await scrape(
        { url: "https://example.com", screenshot: true },
        {
          ...depsFor(makePage().page),
          acquireBrowser: async () => {
            browserAcquired = true
            return freshHandle(makePage().page)
          },
        },
      )

      expect(result.tier).toBe(1)
      expect(result.screenshot).toBeUndefined()
      expect(browserAcquired).toBeFalse()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("emits the tier's screenshot on the scrape result when requested", async () => {
    const { page } = makePage()

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 3, maxTimeout: 4_000, screenshot: true },
      depsFor(page),
    )

    expect(result.tier).toBe(3)
    expect(result.screenshot).toBe(JPEG_BASE64)
    expect(result.timings.every((timing) => !("screenshot" in timing))).toBeTrue()
    expect(
      result.timings.every((timing) =>
        Object.keys(timing).every((key) => ["tier", "status", "durationMs", "reason"].includes(key)),
      ),
    ).toBeTrue()
  })

  test("passes full-page and selector options through the orchestrator", async () => {
    const { page, screenshotCalls, selectorCalls } = makePage()
    page.evaluate = async () => ({ width: 1920, height: 2400 })

    const result = await scrape(
      {
        url: "https://example.com",
        skipHttp: true,
        maxTier: 3,
        maxTimeout: 4_000,
        screenshot: true,
        screenshotFullPage: true,
        screenshotWaitForSelector: ".ready",
      },
      depsFor(page),
    )

    expect(result.screenshot).toBe(JPEG_BASE64)
    expect(selectorCalls).toEqual([".ready"])
    expect(screenshotCalls[0].fullPage).toBe(true)
  })

  test("passes an element selector through the orchestrator", async () => {
    const { page } = makePage()
    let captured = false
    page.locator = (selector: string) => {
      expect(selector).toBe(".chart")
      return {
        filter: () => ({
          first: () => ({
            boundingBox: async () => ({ x: 0, y: 0, width: 500, height: 400 }),
            screenshot: async () => {
              captured = true
              return JPEG
            },
          }),
        }),
      }
    }

    const result = await scrape(
      {
        url: "https://example.com",
        skipHttp: true,
        maxTier: 3,
        maxTimeout: 4_000,
        screenshot: true,
        screenshotSelector: ".chart",
      },
      depsFor(page),
    )

    expect(captured).toBeTrue()
    expect(result.screenshot).toBe(JPEG_BASE64)
  })

  test("waits for rendered content before reading the browser HTML", async () => {
    const { page, selectorCalls } = makePage()
    let rendered = false
    page.content = async () =>
      rendered ? PAGE_HTML.replace("</body>", '<div class="card">Ready</div></body>') : PAGE_HTML
    page.waitForSelector = async (selector: string) => {
      selectorCalls.push(selector)
      rendered = true
    }

    const result = await scrape(
      {
        url: "https://example.com",
        skipHttp: true,
        maxTier: 3,
        maxTimeout: 4_000,
        contentWaitForSelector: ".card",
      },
      depsFor(page),
    )

    expect(selectorCalls).toEqual([".card"])
    expect(result.html).toContain("Ready")
  })

  test("keeps the outbound policy installed when screenshots are requested", async () => {
    const { page, routePatterns } = makePage()
    const validateOutboundUrl = async () => {}

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 3, maxTimeout: 4_000, screenshot: true },
      { ...depsFor(page), validateOutboundUrl },
    )

    expect(result.screenshot).toBe(JPEG_BASE64)
    expect(routePatterns).toContain("**/*")
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
