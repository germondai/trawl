import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { SessionData } from "@trawl/types"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { runTier2 } from "../src/tiers/2"
import { attachResponseCapture } from "../src/utils/responseCapture"

const PAGE_HTML = `<html><head><title>Shell</title></head><body>${"content ".repeat(20)}</body></html>`

const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" }

const mainFrame = {}

const response = (
  url: string,
  options: {
    status?: number
    contentType?: string | null
    body?: Buffer | Error
    contentLength?: number
    wireSize?: number
    onRead?: () => void
  } = {},
) => ({
  url: () => url,
  status: () => options.status ?? 200,
  headers: () => ({
    ...(options.contentType === null ? {} : { "content-type": options.contentType ?? "application/json" }),
    ...(options.contentLength ? { "content-length": String(options.contentLength) } : {}),
  }),
  body: async () => {
    options.onRead?.()
    if (options.body instanceof Error) throw options.body
    return options.body ?? Buffer.from('{"items":[1,2]}')
  },
  request: () => ({
    isNavigationRequest: () => false,
    frame: () => mainFrame,
    sizes: async () => ({
      requestBodySize: 0,
      requestHeadersSize: 0,
      responseBodySize: options.wireSize ?? 0,
      responseHeadersSize: 0,
    }),
  }),
})

const documentResponse = (url: string, status = 200) => ({
  url: () => url,
  status: () => status,
  headers: () => ({ "content-type": "text/html" }),
  body: async () => Buffer.from("origin"),
  request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
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

const makePage = (onGoto: (emit: Emitter["emit"]) => void = () => {}, selectorFound = false) => {
  const emitter = makeEmitter()
  const page = {
    ...emitter,
    url: () => "https://example.com/landed",
    title: async () => "Shell",
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
    waitForSelector: async () => {
      if (!selectorFound) throw new Error("selector timeout")
      return {}
    },
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

const MAX_BODY_BYTES = 5_242_880
const MAX_READ_BYTES = MAX_BODY_BYTES * 2

describe("attachResponseCapture", () => {
  test("attaches nothing and captures nothing without patterns", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { settleTimeout: 5_000, waitForSelector: "#ignored" })
    emitter.emit("response", response("https://example.com/api/search"))

    expect(emitter.listeners("response")).toBe(0)
    expect(emitter.listeners("close")).toBe(0)
    expect(await capture.drain()).toBeUndefined()
  })

  test("captures a matching text body with its status and headers", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit("response", response("https://example.com/api/search?q=shoes", { status: 201 }))
    emitter.emit("response", response("https://example.com/api/other"))

    expect(await capture.drain()).toEqual([
      {
        url: "https://example.com/api/search?q=shoes",
        status: 201,
        headers: { "content-type": "application/json" },
        body: '{"items":[1,2]}',
        base64Encoded: false,
        truncated: false,
      },
    ])
  })

  test("matches a glob against the whole URL", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["https://*.example.com/api/*"] })
    emitter.emit("response", response("https://cdn.example.com/api/items"))
    emitter.emit("response", response("https://cdn.example.com/static/items"))

    const entries = await capture.drain()
    expect(entries?.map((entry) => entry.url)).toEqual(["https://cdn.example.com/api/items"])
  })

  test("base64-encodes a binary body", async () => {
    const { page, emitter } = makePage()
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])

    const capture = attachResponseCapture(page as never, { captureResponses: ["/tile.png"] })
    emitter.emit("response", response("https://example.com/tile.png", { contentType: "image/png", body: raw }))

    const entries = await capture.drain()
    expect(entries?.[0].base64Encoded).toBe(true)
    expect(entries?.[0].truncated).toBe(false)
    expect(Buffer.from(entries?.[0].body ?? "", "base64").equals(raw)).toBe(true)
  })

  test("base64-encodes a body whose content type is missing", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit("response", response("https://example.com/api/search", { contentType: null }))

    const entries = await capture.drain()
    expect(entries?.[0].base64Encoded).toBe(true)
    expect(Buffer.from(entries?.[0].body ?? "", "base64").toString()).toBe('{"items":[1,2]}')
  })

  test("flags an oversize body as truncated at the per-body cap", async () => {
    const { page, emitter } = makePage()
    const raw = Buffer.alloc(MAX_BODY_BYTES + 4_096, 0x61)

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit("response", response("https://example.com/api/search", { body: raw }))

    const entries = await capture.drain()
    expect(entries?.[0].truncated).toBe(true)
    expect(entries?.[0].body).toHaveLength(MAX_BODY_BYTES)
    expect(entries?.[0].error).toBeUndefined()
  })

  test("records an error once the total byte budget is spent", async () => {
    const { page, emitter } = makePage()
    const raw = Buffer.alloc(MAX_BODY_BYTES, 0x61)

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"] })
    for (let i = 0; i < 3; i++) emitter.emit("response", response(`https://example.com/api/page-${i}`, { body: raw }))

    const entries = await capture.drain()
    expect(entries?.map((entry) => entry.body?.length ?? null)).toEqual([MAX_BODY_BYTES, MAX_BODY_BYTES, null])
    expect(entries?.[2].error).toBe("total capture budget exhausted")
  })

  test("never reads a body whose declared length is past the read ceiling", async () => {
    const { page, emitter } = makePage()
    let read = false

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit(
      "response",
      response("https://example.com/api/search", {
        contentLength: MAX_READ_BYTES + 1,
        onRead: () => {
          read = true
        },
      }),
    )

    const entries = await capture.drain()
    expect(read).toBe(false)
    expect(entries?.[0].body).toBeNull()
    expect(entries?.[0].error).toContain("read ceiling")
  })

  test("measures an undeclared body before reading it, and refuses an oversize one", async () => {
    const { page, emitter } = makePage()
    let read = false

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"] })
    emitter.emit(
      "response",
      response("https://example.com/api/stream", {
        wireSize: MAX_READ_BYTES + 1,
        onRead: () => {
          read = true
        },
      }),
    )
    emitter.emit("response", response("https://example.com/api/small", { wireSize: 15 }))

    const entries = await capture.drain()
    expect(read).toBe(false)
    expect(entries?.[0].error).toContain("read ceiling")
    expect(entries?.[1].body).toBe('{"items":[1,2]}')
  })

  test("still trims a body between the keep cap and the read ceiling", async () => {
    const { page, emitter } = makePage()
    const raw = Buffer.alloc(MAX_BODY_BYTES + 4_096, 0x61)

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit(
      "response",
      response("https://example.com/api/search", { body: raw, contentLength: raw.length, wireSize: raw.length }),
    )

    const entries = await capture.drain()
    expect(entries?.[0].truncated).toBe(true)
    expect(entries?.[0].body).toHaveLength(MAX_BODY_BYTES)
  })

  test("charges reads in flight, so a burst is refused before its bodies are read", async () => {
    const { page, emitter } = makePage()
    const reads: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"] })
    for (let i = 0; i < 3; i++) {
      const url = `https://example.com/api/page-${i}`
      emitter.emit("response", {
        ...response(url, { contentLength: MAX_BODY_BYTES }),
        body: async () => {
          reads.push(url)
          await gate
          return Buffer.from('{"items":[1,2]}')
        },
      })
    }
    release()

    const entries = await capture.drain()
    expect(reads).toHaveLength(2)
    expect(entries?.[2].body).toBeNull()
    expect(entries?.[2].error).toBe("total capture budget exhausted")
  })

  test("refuses a measured body that the reads already in flight leave no room for", async () => {
    const { page, emitter } = makePage()
    const reads: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"] })
    for (let i = 0; i < 2; i++) {
      const url = `https://example.com/api/page-${i}`
      emitter.emit("response", {
        ...response(url, { wireSize: 6_291_456 }),
        body: async () => {
          reads.push(url)
          await gate
          return Buffer.from('{"items":[1,2]}')
        },
      })
    }
    // Released off the microtask queue, so every read has been measured and either
    // reserved or refused before the first body lands.
    setTimeout(release, 0)

    const entries = await capture.drain()
    expect(reads).toEqual(["https://example.com/api/page-0"])
    expect(entries?.[1].body).toBeNull()
    expect(entries?.[1].error).toBe("capture budget held by reads in flight")
  })

  test("records the reason when a matched body cannot be read", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit("response", response("https://example.com/api/search", { body: new Error("target closed") }))

    const entries = await capture.drain()
    expect(entries).toHaveLength(1)
    expect(entries?.[0].body).toBeNull()
    expect(entries?.[0].error).toBe("body read failed: target closed")
  })

  test("gives up on a body read that never lands", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit("response", { ...response("https://example.com/api/search"), body: () => new Promise(() => {}) })

    const entries = await capture.drain()
    expect(entries?.[0].body).toBeNull()
    expect(entries?.[0].error).toBe("body read did not complete")
  }, 10_000)

  test("caps the number of captured bodies", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"] })
    for (let i = 0; i < 8; i++) emitter.emit("response", response(`https://example.com/api/page-${i}`))

    const entries = await capture.drain()
    expect(entries).toHaveLength(5)
    expect(entries?.at(-1)?.url).toBe("https://example.com/api/page-4")
  })

  test("skips redirects, which have no body of their own", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/search"] })
    emitter.emit("response", response("https://example.com/api/search", { status: 302 }))
    emitter.emit("response", response("https://example.com/api/search", { status: 200 }))

    const entries = await capture.drain()
    expect(entries?.map((entry) => entry.status)).toEqual([200])
  })

  test("survives a response object that throws", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"] })
    emitter.emit("response", {
      url: () => {
        throw new Error("execution context destroyed")
      },
    })
    emitter.emit("response", response("https://example.com/api/search"))

    const entries = await capture.drain()
    expect(entries?.map((entry) => entry.url)).toEqual(["https://example.com/api/search"])
  })

  test("stops capturing once the page closes and once it is drained", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"] })
    emitter.emit("response", response("https://example.com/api/during"))
    emitter.emit("close", page)
    emitter.emit("response", response("https://example.com/api/after-close"))

    expect(emitter.listeners("response")).toBe(0)
    expect(emitter.listeners("close")).toBe(0)

    const entries = await capture.drain()
    expect(entries?.map((entry) => entry.url)).toEqual(["https://example.com/api/during"])
  })
})

describe("settle window", () => {
  test("ends as soon as a body is captured", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"], settleTimeout: 5_000 })
    emitter.emit("response", response("https://example.com/api/search"))

    const started = Date.now()
    await capture.settle(5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("ends at the deadline when nothing matches", async () => {
    const { page } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"], settleTimeout: 120 })
    const started = Date.now()
    await capture.settle(5_000)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  test("ends early when wait-for-selector resolves", async () => {
    const { page } = makePage(() => {}, true)

    const capture = attachResponseCapture(page as never, {
      captureResponses: ["/api/"],
      settleTimeout: 5_000,
      waitForSelector: "#results",
    })
    const started = Date.now()
    await capture.settle(5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("is skipped when the request has no budget left", async () => {
    const { page } = makePage()

    const capture = attachResponseCapture(page as never, { captureResponses: ["/api/"], settleTimeout: 5_000 })
    const started = Date.now()
    await capture.settle(0)
    expect(Date.now() - started).toBeLessThan(100)
  })
})

describe("browser tiers", () => {
  const shell = (emit: Emitter["emit"]) => {
    emit("response", documentResponse("https://example.com/"))
    emit("response", response("https://example.com/api/search?q=shoes"))
  }

  test("Tier 2 returns the captured bodies only when asked", async () => {
    const requested = makePage(shell)
    const withCapture = await runTier2(
      "https://example.com",
      poolHandle(requested.page),
      session,
      4_000,
      {},
      "GET",
      "",
      false,
      { captureResponses: ["/api/search"], settleTimeout: 50 },
    )

    expect(withCapture.status).toBe("success")
    expect(withCapture.capturedResponses).toEqual([
      {
        url: "https://example.com/api/search?q=shoes",
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"items":[1,2]}',
        base64Encoded: false,
        truncated: false,
      },
    ])

    const untouched = makePage(shell)
    const withoutCapture = await runTier2("https://example.com", poolHandle(untouched.page), session, 4_000)

    expect(withoutCapture.status).toBe("success")
    expect(withoutCapture.capturedResponses).toBeUndefined()
    // Only the main-document tracker's listener — capture attached nothing.
    expect(untouched.emitter.listeners("response")).toBe(1)
    expect(requested.emitter.listeners("response")).toBe(1)
  })

  test("a pattern that matches nothing yields an empty array, not undefined", async () => {
    const { page } = makePage(shell)
    const result = await runTier2("https://example.com", poolHandle(page), session, 4_000, {}, "GET", "", false, {
      captureResponses: ["/api/never"],
      settleTimeout: 50,
    })

    expect(result.status).toBe("success")
    expect(result.capturedResponses).toEqual([])
  })

  test("capture rides alongside the other evidence flags", async () => {
    const { page } = makePage((emit) => {
      shell(emit)
      emit("console", { type: () => "error", text: () => "boom", timestamp: () => 1 })
    })

    const result = await runTier2("https://example.com", poolHandle(page), session, 4_000, {}, "GET", "", false, {
      consoleLogs: true,
      captureResponses: ["/api/search"],
      settleTimeout: 50,
    })

    expect(result.consoleLogs?.map((entry) => entry.message)).toEqual(["boom"])
    expect(result.capturedResponses).toHaveLength(1)
    expect(result.networkLogs).toBeUndefined()
    expect(result.redirectChain).toBeUndefined()
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

  test("passes the capture spec through and returns the bodies", async () => {
    const { page } = makePage((emit) => {
      emit("response", documentResponse("https://example.com/"))
      emit("response", response("https://example.com/api/search"))
    })

    const result = await scrape(
      {
        url: "https://example.com",
        skipHttp: true,
        maxTier: 2,
        maxTimeout: 4_000,
        captureResponses: ["/api/search"],
        settleTimeout: 50,
        waitForSelector: "#results",
      },
      depsFor(page),
    )

    expect(result.tier).toBe(2)
    expect(result.capturedResponses?.map((entry) => entry.body)).toEqual(['{"items":[1,2]}'])
  })

  test("omits the field entirely by default", async () => {
    const { page, emitter } = makePage((emit) => {
      emit("response", documentResponse("https://example.com/"))
      emit("response", response("https://example.com/api/search"))
    })

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 2, maxTimeout: 4_000 },
      depsFor(page),
    )

    expect(result.tier).toBe(2)
    expect(result.capturedResponses).toBeUndefined()
    expect(emitter.listeners("response")).toBe(1)
  })
})
