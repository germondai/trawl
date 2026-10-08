import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { BlockedEvidence, SessionData } from "@trawl/types"
import type { OrchestratorDeps } from "../src/orchestrator"
import { ScrapeError, scrape } from "../src/orchestrator"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"
import { DATADOME_HTML_HARD_BLOCK } from "./fixtures/datadome"

const WALL_HTML = `<html><head><title>Access denied</title></head><body><h1>403</h1>${"blocked ".repeat(40)}</body></html>`
const JPEG = Buffer.from("fake-jpeg-bytes")
const JPEG_BASE64 = JPEG.toString("base64")

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64" as const, locale: "en-US", timezone: "UTC" }
const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

interface PageStub {
  page: any
  contentReads: () => number
  screenshotCalls: () => number
}

const makePage = (options: { html?: string; status?: number; contentThrows?: boolean } = {}): PageStub => {
  const mainFrame = {}
  let contentReads = 0
  let screenshotCalls = 0
  const navigationResponse = {
    url: () => "https://example.com/blocked",
    status: () => options.status ?? 403,
    headers: () => ({}),
    body: async () => Buffer.from(options.html ?? WALL_HTML),
    request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
  }
  const page = {
    url: () => "https://example.com/blocked",
    title: async () => "Access denied",
    content: async () => {
      contentReads++
      if (options.contentThrows) throw new Error("Target page, context or browser has been closed")
      return options.html ?? WALL_HTML
    },
    goto: async () => {},
    on: (event: string, handler: (response: unknown) => void) => {
      if (event === "response") handler(navigationResponse)
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
    keyboard: { press: async () => {} },
    mouse: { move: async () => {}, click: async () => {} },
    screenshot: async () => {
      screenshotCalls++
      return JPEG
    },
  }
  return { page, contentReads: () => contentReads, screenshotCalls: () => screenshotCalls }
}

const poolHandle = (page: unknown): BrowserHandle =>
  ({
    id: 1,
    lease: 1,
    headful: false,
    context: { newPage: async () => page, addCookies: async () => {}, cookies: async () => [] },
    browser: {},
    fingerprint,
  }) satisfies BrowserHandle

const freshHandle = (page: unknown): BrowserHandle =>
  ({
    id: 2,
    lease: 1,
    headful: false,
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

const sink = (screenshot?: boolean) => {
  const reported: BlockedEvidence[] = []
  return { reported, sink: { screenshot, report: (evidence: BlockedEvidence) => reported.push(evidence) } }
}

describe("blocked evidence", () => {
  test("Tier 2 reports the wall it stopped at, with an image only when a screenshot was asked for", async () => {
    const { reported, sink: withImage } = sink(true)
    const imaged = makePage()
    const blocked = await runTier2(
      "https://example.com",
      poolHandle(imaged.page),
      session,
      4_000,
      {},
      "GET",
      "",
      undefined,
      true,
      { blockedEvidence: withImage },
    )

    expect(blocked.status).toBe("blocked")
    expect(blocked.reason).toBe("http-403")
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      tier: 2,
      status: "blocked",
      reason: "http-403",
      url: "https://example.com/blocked",
      statusCode: 403,
    })
    expect(reported[0].html).toContain("Access denied")
    expect(reported[0].screenshot).toBe(JPEG_BASE64)
    expect(reported[0].htmlTruncated).toBeUndefined()

    const { reported: textOnly, sink: withoutImage } = sink()
    const unimaged = makePage()
    await runTier2("https://example.com", poolHandle(unimaged.page), session, 4_000, {}, "GET", "", undefined, false, {
      blockedEvidence: withoutImage,
    })

    expect(textOnly[0].html).toContain("Access denied")
    expect(textOnly[0].screenshot).toBeUndefined()
    expect(unimaged.screenshotCalls()).toBe(0)
  })

  test("a request that did not ask for evidence reads nothing extra off the wall", async () => {
    const untouched = makePage()
    const blocked = await runTier2("https://example.com", poolHandle(untouched.page), session, 4_000)

    expect(blocked.status).toBe("blocked")
    expect(blocked.reason).toBe("http-403")
    expect(untouched.screenshotCalls()).toBe(0)
    expect(untouched.contentReads()).toBe(1)
  })

  test("does not start browser work or a screenshot with an expired request budget", async () => {
    const { reported, sink: asked } = sink(true)
    const wall = makePage()

    const blocked = await runTier2(
      "https://example.com",
      poolHandle(wall.page),
      session,
      0,
      {},
      "GET",
      "",
      undefined,
      true,
      { blockedEvidence: asked },
    )

    expect(blocked.status).toBe("timeout")
    expect(reported).toHaveLength(0)
    expect(wall.screenshotCalls()).toBe(0)
  })

  test("Tier 3 reports the persistent wall and keeps the tier result unchanged", async () => {
    const { reported, sink: asked } = sink(true)
    const stub = makePage()
    const blocked = await runTier3(
      "https://example.com",
      freshHandle(stub.page),
      4_000,
      undefined,
      {},
      "GET",
      "",
      undefined,
      true,
      {
        blockedEvidence: asked,
      },
    )

    expect(blocked).toEqual({ tier: 3, status: "blocked", durationMs: blocked.durationMs, reason: "http-403" })
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ tier: 3, reason: "http-403", statusCode: 403 })
    expect(reported[0].screenshot).toBe(JPEG_BASE64)
  })

  test("Tier 4 reports the wall without changing its blocked result", async () => {
    const { reported, sink: asked } = sink()
    const stub = makePage()
    const blocked = await runTier4(
      "https://example.com",
      freshHandle(stub.page),
      4_000,
      "http://proxy.example:8080",
      {},
      "GET",
      "",
      undefined,
      false,
      { blockedEvidence: asked },
    )

    expect(blocked).toEqual({ tier: 4, status: "blocked", durationMs: blocked.durationMs, reason: "http-403" })
    expect(reported[0]).toMatchObject({ tier: 4, reason: "http-403", statusCode: 403 })
    expect(reported[0].html).toContain("Access denied")
  })

  test("reports evidence for the current DataDome cached-session branch", async () => {
    const { reported, sink: asked } = sink()
    const blocked = await runTier2(
      "https://example.com",
      poolHandle(makePage({ html: DATADOME_HTML_HARD_BLOCK }).page),
      session,
      4_000,
      {},
      "GET",
      "",
      undefined,
      false,
      { blockedEvidence: asked },
    )

    expect(blocked.reason).toBe("datadome-session-expired")
    expect(reported[0]).toMatchObject({ tier: 2, status: "blocked", reason: "datadome-session-expired" })
  })

  test("markup past the cap is truncated and flagged rather than dropped", async () => {
    const oversize = `<html><head><title>Access denied</title></head><body>${"x".repeat(600_000)}</body></html>`
    const { reported, sink: asked } = sink()
    await runTier2(
      "https://example.com",
      poolHandle(makePage({ html: oversize }).page),
      session,
      4_000,
      {},
      "GET",
      "",
      undefined,
      false,
      {
        blockedEvidence: asked,
      },
    )

    expect(reported[0].html).toHaveLength(512_000)
    expect(reported[0].htmlTruncated).toBe(true)
  })

  test("a capture that fails degrades the evidence and never touches the tier's outcome", async () => {
    const throwing = {
      screenshot: true,
      report: () => {
        throw new Error("sink exploded")
      },
    }
    const blocked = await runTier2(
      "https://example.com",
      poolHandle(makePage().page),
      session,
      4_000,
      {},
      "GET",
      "",
      undefined,
      true,
      { blockedEvidence: throwing },
    )

    expect(blocked.status).toBe("blocked")
    expect(blocked.reason).toBe("http-403")
  })

  test("an unreadable page ends the tier as an error, with no wall to report", async () => {
    const { reported, sink: asked } = sink(true)
    const blocked = await runTier2(
      "https://example.com",
      poolHandle(makePage({ contentThrows: true }).page),
      session,
      4_000,
      {},
      "GET",
      "",
      undefined,
      true,
      { blockedEvidence: asked },
    )

    expect(blocked.status).toBe("error")
    expect(reported).toHaveLength(0)
  })
})

describe("blocked evidence through the orchestrator", () => {
  const depsFor = (pool: unknown, fresh: unknown, hasSession = true): OrchestratorDeps => ({
    acquireBrowser: async () => ({ ...poolHandle(pool), browser: freshHandle(fresh).browser }),
    releaseBrowser: () => {},
    loadSession: async () => (hasSession ? session : undefined),
    saveSession: async () => {},
    invalidateSession: async () => {},
  })

  test("the deepest tier that rendered a wall is the one that reaches the caller", async () => {
    const wall = (marker: string) =>
      `<html><head><title>Access denied</title></head><body><h1>403</h1>${marker}${"blocked ".repeat(40)}</body></html>`
    const tier2Wall = makePage({ html: wall("tier two wall") })
    const tier3Wall = makePage({ html: wall("tier three wall") })

    const error = (await scrape(
      {
        url: "https://example.com",
        skipHttp: true,
        maxTier: 3,
        maxTimeout: 4_000,
        blockedEvidence: true,
        screenshot: true,
      },
      depsFor(tier2Wall.page, tier3Wall.page),
    ).catch((err) => err)) as ScrapeError

    expect(error).toBeInstanceOf(ScrapeError)
    expect(error.timings.map((t) => `${t.tier}:${t.status}:${t.reason}`)).toEqual([
      "2:blocked:http-403",
      "3:blocked:http-403",
    ])
    expect(error.blockedEvidence?.tier).toBe(3)
    expect(error.blockedEvidence?.html).toContain("tier three wall")
    expect(error.blockedEvidence?.screenshot).toBe(JPEG_BASE64)
  })

  test("no evidence rides the error unless the request asked for it", async () => {
    const tier2Wall = makePage()

    const error = (await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 2, maxTimeout: 4_000 },
      depsFor(tier2Wall.page, tier2Wall.page),
    ).catch((err) => err)) as ScrapeError

    expect(error).toBeInstanceOf(ScrapeError)
    expect(error.timings).toHaveLength(1)
    expect(error.timings[0].reason).toBe("http-403")
    expect(error.blockedEvidence).toBeUndefined()
    expect(tier2Wall.screenshotCalls()).toBe(0)
  })
})
