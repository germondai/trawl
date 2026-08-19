import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { SessionData } from "@trawl/types"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { runTier2 } from "../src/tiers/2"
import { attachPageCapture } from "../src/utils/capture"
import { MainDocumentResponseTracker } from "../src/utils/mainResponse"

const PAGE_HTML = `<html><head><title>Ordinary Page</title></head><body>${"content ".repeat(20)}</body></html>`

const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" }

const mainFrame = {}
const iframe = {}

const consoleMessage = (type: string, text: string, timestamp = 1_700_000_000_000) => ({
  type: () => type,
  text: () => text,
  timestamp: () => timestamp,
})

const request = (
  url: string,
  options: { navigation?: boolean; resourceType?: string; responseEnd?: number; sizes?: boolean } = {},
) => ({
  url: () => url,
  isNavigationRequest: () => options.navigation ?? false,
  resourceType: () => options.resourceType ?? "script",
  timing: () => ({ startTime: Date.now(), responseEnd: options.responseEnd ?? 42 }),
  sizes: async () => {
    if (options.sizes === false) throw new Error("sizes unavailable")
    return { requestBodySize: 0, requestHeadersSize: 50, responseBodySize: 800, responseHeadersSize: 200 }
  },
})

const documentResponse = (url: string, status = 200, frame: object = mainFrame) => ({
  url: () => url,
  status: () => status,
  headers: () => ({ "content-type": "text/html" }),
  body: async () => Buffer.from("origin"),
  request: () => ({ isNavigationRequest: () => true, frame: () => frame }),
})

interface Emitter {
  emit(event: string, arg: unknown): void
  listeners(event: string): number
}

const makeEmitter = (): Emitter & { on: unknown; off: unknown; once: unknown } => {
  const handlers = new Map<string, Array<(arg: never) => void>>()
  return {
    on: (event: string, handler: (arg: never) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    once: (event: string, handler: (arg: never) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    off: (event: string, handler: (arg: never) => void) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== handler),
      )
    },
    emit(event, arg) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(arg as never)
    },
    listeners: (event: string) => (handlers.get(event) ?? []).length,
  }
}

const makePage = (onGoto: (emit: Emitter["emit"]) => void = () => {}) => {
  const emitter = makeEmitter()
  const page = {
    ...emitter,
    url: () => "https://example.com/landed",
    title: async () => "Ordinary Page",
    content: async () => PAGE_HTML,
    goto: async () => {
      onGoto(emitter.emit)
    },
    mainFrame: () => mainFrame,
    frames: () => [],
    context: () => ({ cookies: async () => [] }),
    evaluate: async () => "test-agent",
    setExtraHTTPHeaders: async () => {},
    waitForLoadState: async () => {},
    screenshot: async () => Buffer.from("jpeg"),
    close: async () => {},
  }
  return { page, emitter }
}

const poolHandle = (page: unknown): BrowserHandle =>
  ({
    id: 1,
    lease: 1,
    context: { newPage: async () => page, addCookies: async () => {}, cookies: async () => [] },
    browser: {},
    fingerprint,
  }) satisfies BrowserHandle

describe("attachPageCapture", () => {
  test("attaches nothing and captures nothing when neither flag is set", async () => {
    const { page, emitter } = makePage()

    const capture = attachPageCapture(page as never, { redirectChain: true })
    emitter.emit("console", consoleMessage("error", "ignored"))

    expect(emitter.listeners("console")).toBe(0)
    expect(emitter.listeners("requestfinished")).toBe(0)
    expect(emitter.listeners("close")).toBe(0)
    expect(await capture.drain()).toEqual({})
  })

  test("captures console messages as level/message/timestamp/source entries", async () => {
    const { page, emitter } = makePage()

    const capture = attachPageCapture(page as never, { consoleLogs: true })
    emitter.emit("console", consoleMessage("error", "Failed to load resource: status of 407 ()", 1_700_000_000_001))
    emitter.emit("console", consoleMessage("warning", "deprecated api"))
    emitter.emit("console", consoleMessage("log", "hello"))
    emitter.emit("console", consoleMessage("debug", "verbose"))
    emitter.emit("requestfinished", request("https://example.com/app.js"))

    const { consoleLogs, networkLogs } = await capture.drain()
    expect(networkLogs).toBeUndefined()
    expect(consoleLogs).toEqual([
      {
        level: "SEVERE",
        message: "Failed to load resource: status of 407 ()",
        timestamp: 1_700_000_000_001,
        source: "error",
      },
      { level: "WARNING", message: "deprecated api", timestamp: 1_700_000_000_000, source: "warning" },
      { level: "INFO", message: "hello", timestamp: 1_700_000_000_000, source: "log" },
      { level: "DEBUG", message: "verbose", timestamp: 1_700_000_000_000, source: "debug" },
    ])
  })

  test("caps console entries when a page floods the console", async () => {
    const { page, emitter } = makePage()

    const capture = attachPageCapture(page as never, { consoleLogs: true })
    for (let i = 0; i < 600; i++) emitter.emit("console", consoleMessage("log", `message ${i}`))

    const { consoleLogs } = await capture.drain()
    expect(consoleLogs).toHaveLength(500)
    expect(consoleLogs?.[0].message).toBe("message 0")
    expect(consoleLogs?.at(-1)?.message).toBe("message 499")
  })

  test("drops an oversized console message instead of truncating it", async () => {
    const { page, emitter } = makePage()

    const capture = attachPageCapture(page as never, { consoleLogs: true })
    emitter.emit("console", consoleMessage("log", "x".repeat(2_001)))
    emitter.emit("console", consoleMessage("log", "kept"))

    const { consoleLogs } = await capture.drain()
    expect(consoleLogs).toHaveLength(1)
    expect(consoleLogs?.[0].message).toBe("kept")
  })

  test("captures resource timings for finished and failed requests", async () => {
    const { page, emitter } = makePage()

    const capture = attachPageCapture(page as never, { networkLogs: true })
    emitter.emit("console", consoleMessage("log", "ignored"))
    emitter.emit(
      "requestfinished",
      request("https://example.com/", { navigation: true, resourceType: "document", responseEnd: 120.456 }),
    )
    emitter.emit("requestfailed", request("https://cdn.example.com/x.png", { responseEnd: -1, sizes: false }))

    const { consoleLogs, networkLogs } = await capture.drain()
    expect(consoleLogs).toBeUndefined()
    expect(networkLogs).toHaveLength(2)
    expect(networkLogs?.[0]).toMatchObject({
      name: "https://example.com/",
      entryType: "navigation",
      duration: 120.46,
      initiatorType: "document",
      transferSize: 1_000,
      encodedBodySize: 800,
      decodedBodySize: null,
    })
    expect(networkLogs?.[0].startTime).toBeGreaterThanOrEqual(0)
    expect(networkLogs?.[1]).toMatchObject({
      name: "https://cdn.example.com/x.png",
      entryType: "resource",
      duration: 0,
      transferSize: null,
      encodedBodySize: null,
      decodedBodySize: null,
    })
  })

  test("caps network entries when a page floods the network", async () => {
    const { page, emitter } = makePage()

    const capture = attachPageCapture(page as never, { networkLogs: true })
    for (let i = 0; i < 1_200; i++) emitter.emit("requestfinished", request(`https://example.com/asset-${i}.js`))

    const { networkLogs } = await capture.drain()
    expect(networkLogs).toHaveLength(1_000)
  })

  test("stops capturing once the page closes and once it is drained", async () => {
    const { page, emitter } = makePage()

    const capture = attachPageCapture(page as never, { consoleLogs: true, networkLogs: true })
    emitter.emit("console", consoleMessage("log", "during"))
    emitter.emit("close", page)
    emitter.emit("console", consoleMessage("log", "after close"))
    emitter.emit("requestfinished", request("https://example.com/after.js"))

    expect(emitter.listeners("console")).toBe(0)
    expect(emitter.listeners("requestfinished")).toBe(0)
    expect(emitter.listeners("close")).toBe(0)

    const { consoleLogs, networkLogs } = await capture.drain()
    expect(consoleLogs?.map((entry) => entry.message)).toEqual(["during"])
    expect(networkLogs).toEqual([])
  })
})

describe("MainDocumentResponseTracker redirect chain", () => {
  test("records the main document's walk in order, deduplicated", () => {
    const tracker = new MainDocumentResponseTracker({ mainFrame: () => mainFrame } as never, true)
    tracker.observe(documentResponse("https://example.com/start", 302) as never)
    tracker.observe(documentResponse("https://example.com/start", 302) as never)
    tracker.observe(documentResponse("https://www.example.com/final") as never)
    tracker.observe(documentResponse("https://challenge.example/frame", 403, iframe) as never)

    expect(tracker.redirectChain).toEqual(["https://example.com/start", "https://www.example.com/final"])
  })

  test("stays empty unless chain recording was asked for", () => {
    const tracker = new MainDocumentResponseTracker({ mainFrame: () => mainFrame } as never)
    tracker.observe(documentResponse("https://example.com/start", 302) as never)
    tracker.observe(documentResponse("https://example.com/final") as never)

    expect(tracker.redirectChain).toEqual([])
    expect(tracker.status).toBe(200)
  })

  test("caps a redirect loop", () => {
    const tracker = new MainDocumentResponseTracker({ mainFrame: () => mainFrame } as never, true)
    for (let i = 0; i < 80; i++) tracker.observe(documentResponse(`https://example.com/hop-${i}`, 302) as never)

    expect(tracker.redirectChain).toHaveLength(50)
  })
})

describe("browser tiers", () => {
  const emitPageActivity = (emit: Emitter["emit"]) => {
    emit("response", documentResponse("https://example.com/start", 302))
    emit("response", documentResponse("https://example.com/final"))
    emit("console", consoleMessage("error", "Failed to load resource: status of 407 ()"))
    emit("requestfinished", request("https://example.com/app.js"))
  }

  test("Tier 2 returns console logs, network logs and the redirect chain only when asked", async () => {
    const requested = makePage(emitPageActivity)
    const withCapture = await runTier2(
      "https://example.com",
      poolHandle(requested.page),
      session,
      4_000,
      {},
      "GET",
      "",
      false,
      { consoleLogs: true, networkLogs: true, redirectChain: true },
    )

    expect(withCapture.status).toBe("success")
    expect(withCapture.consoleLogs?.map((entry) => entry.level)).toEqual(["SEVERE"])
    expect(withCapture.networkLogs?.map((entry) => entry.name)).toEqual(["https://example.com/app.js"])
    expect(withCapture.redirectChain).toEqual(["https://example.com/start", "https://example.com/final"])

    const untouched = makePage(emitPageActivity)
    const withoutCapture = await runTier2("https://example.com", poolHandle(untouched.page), session, 4_000)

    expect(withoutCapture.status).toBe("success")
    expect(withoutCapture.consoleLogs).toBeUndefined()
    expect(withoutCapture.networkLogs).toBeUndefined()
    expect(withoutCapture.redirectChain).toBeUndefined()
    expect(untouched.emitter.listeners("console")).toBe(0)
    expect(untouched.emitter.listeners("requestfinished")).toBe(0)
  })

  test("a partial capture request returns only the fields it asked for", async () => {
    const { page } = makePage(emitPageActivity)
    const result = await runTier2("https://example.com", poolHandle(page), session, 4_000, {}, "GET", "", false, {
      consoleLogs: true,
    })

    expect(result.consoleLogs).toHaveLength(1)
    expect(result.networkLogs).toBeUndefined()
    expect(result.redirectChain).toBeUndefined()
  })

  test("capture never fails the scrape when the page misbehaves", async () => {
    const { page } = makePage((emit) => {
      emit("console", { type: () => "error", text: () => "gone", timestamp: () => 1 })
      emit("console", {
        type: () => {
          throw new Error("execution context destroyed")
        },
      })
    })

    const result = await runTier2("https://example.com", poolHandle(page), session, 4_000, {}, "GET", "", false, {
      consoleLogs: true,
    })

    expect(result.status).toBe("success")
    expect(result.html).toContain("Ordinary Page")
    expect(result.consoleLogs?.map((entry) => entry.message)).toEqual(["gone"])
  })
})

describe("orchestrator", () => {
  const depsFor = (page: unknown): OrchestratorDeps => ({
    acquireBrowser: async () => poolHandle(page),
    releaseBrowser: () => {},
    loadSession: async () => session,
    saveSession: async () => {},
    invalidateSession: async () => {},
  })

  test("passes the capture flags through and emits the captured evidence", async () => {
    const { page } = makePage((emit) => {
      emit("response", documentResponse("https://example.com/start", 301))
      emit("response", documentResponse("https://example.com/final"))
      emit("console", consoleMessage("warning", "mixed content"))
      emit("requestfinished", request("https://example.com/app.js"))
    })

    const result = await scrape(
      {
        url: "https://example.com",
        skipHttp: true,
        maxTier: 2,
        maxTimeout: 4_000,
        consoleLogs: true,
        networkLogs: true,
        redirectChain: true,
      },
      depsFor(page),
    )

    expect(result.tier).toBe(2)
    expect(result.consoleLogs?.map((entry) => entry.message)).toEqual(["mixed content"])
    expect(result.networkLogs?.map((entry) => entry.initiatorType)).toEqual(["script"])
    expect(result.redirectChain).toEqual(["https://example.com/start", "https://example.com/final"])
  })

  test("omits every capture field by default", async () => {
    const { page, emitter } = makePage((emit) => {
      emit("response", documentResponse("https://example.com/final"))
      emit("console", consoleMessage("error", "boom"))
      emit("requestfinished", request("https://example.com/app.js"))
    })

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 2, maxTimeout: 4_000 },
      depsFor(page),
    )

    expect(result.tier).toBe(2)
    expect(result.consoleLogs).toBeUndefined()
    expect(result.networkLogs).toBeUndefined()
    expect(result.redirectChain).toBeUndefined()
    expect(emitter.listeners("console")).toBe(0)
    expect(emitter.listeners("requestfinished")).toBe(0)
  })
})
