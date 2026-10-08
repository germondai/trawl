import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { SessionData } from "@trawl/types"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { runTier2 } from "../src/tiers/2"
import { assembleBoundedMhtml, assembleMhtml, toQuotedPrintable } from "../src/utils/mhtml"
import { attachResponseCapture } from "../src/utils/responseCapture"

const PAGE_HTML = `<html><head><title>Shell</title></head><body>${"content ".repeat(20)}</body></html>`

const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64" as const, locale: "en-US", timezone: "UTC" }

const mainFrame = {}

const resource = (
  url: string,
  resourceType: string,
  options: {
    status?: number
    contentType?: string | null
    body?: Buffer | Error
    contentLength?: number | null
    contentEncoding?: string
  } = {},
) => {
  const defaultBody = Buffer.from("body{color:red}")
  const bodyLength = options.body instanceof Buffer ? options.body.length : defaultBody.length
  const responseHeaders = {
    ...(options.contentType === null ? {} : { "content-type": options.contentType ?? "text/css" }),
    ...(options.contentLength === null ? {} : { "content-length": String(options.contentLength ?? bodyLength) }),
    ...(options.contentEncoding ? { "content-encoding": options.contentEncoding } : {}),
  }
  return {
    url: () => url,
    status: () => options.status ?? 200,
    headers: () => responseHeaders,
    allHeaders: async () => responseHeaders,
    body: async () => {
      if (options.body instanceof Error) throw options.body
      return options.body ?? defaultBody
    },
    request: () => ({ isNavigationRequest: () => false, frame: () => mainFrame, resourceType: () => resourceType }),
  }
}

const documentResponse = (url: string) => ({
  ...resource(url, "document", { contentType: "text/html", body: Buffer.from("<html>origin</html>") }),
  request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame, resourceType: () => "document" }),
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
      throw new Error("selector timeout")
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
    headful: false,
    context: { newPage: async () => page, addCookies: async () => {}, cookies: async () => [] },
    browser: {},
    fingerprint,
  }) satisfies BrowserHandle

/** Splits an archive into its header block and its parts, the way a MIME reader would. */
const parseArchive = (archive: string) => {
  const [header, ...rest] = archive.split("\r\n\r\n")
  const boundary = /boundary="([^"]+)"/.exec(header)?.[1] ?? ""
  const body = rest.join("\r\n\r\n")
  expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true)
  const parts = body
    .slice(0, -`--${boundary}--\r\n`.length)
    .split(`--${boundary}\r\n`)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const split = chunk.indexOf("\r\n\r\n")
      const headers = Object.fromEntries(
        chunk
          .slice(0, split)
          .split("\r\n")
          .map((line) => {
            const at = line.indexOf(": ")
            return [line.slice(0, at).toLowerCase(), line.slice(at + 2)]
          }),
      )
      return { headers, content: chunk.slice(split + 4).replace(/\r\n$/, "") }
    })
  const headers = Object.fromEntries(
    header.split("\r\n").map((line) => {
      const at = line.indexOf(": ")
      return [line.slice(0, at).toLowerCase(), line.slice(at + 2)]
    }),
  )
  return { boundary, headers, parts }
}

const fromQuotedPrintable = (content: string): Buffer =>
  Buffer.from(
    content
      .replace(/=\r\n/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
    "latin1",
  )

describe("quoted-printable", () => {
  test("round-trips non-ASCII bytes and escapes the escape character", () => {
    const raw = Buffer.from("café = 1 ✓\r\nsecond line\r\n", "utf8")
    const encoded = toQuotedPrintable(raw)

    expect(encoded).toContain("=3D")
    expect(encoded).not.toContain("café")
    expect(fromQuotedPrintable(encoded).equals(Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n")))).toBe(true)
  })

  test("keeps every line inside the 76-character limit", () => {
    const encoded = toQuotedPrintable(Buffer.from(`${"x".repeat(500)}\r\n${"é".repeat(200)}`, "utf8"))

    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76)
  })

  test("encodes whitespace that would otherwise end a line", () => {
    const encoded = toQuotedPrintable(Buffer.from("trailing \r\ntab\t\r\n", "utf8"))

    expect(encoded.split("\r\n")[0]).toBe("trailing=20")
    expect(encoded.split("\r\n")[1]).toBe("tab=09")
    expect(toQuotedPrintable(Buffer.from("no newline ", "utf8"))).toBe("no newline=20")
  })
})

describe("assembleMhtml", () => {
  test("puts the main document first, under multipart/related", () => {
    const archive = assembleMhtml({
      url: "https://example.com/page",
      html: "<html><body>main</body></html>",
      parts: [
        {
          location: "https://example.com/app.css",
          contentType: "text/css",
          encoding: "quoted-printable",
          content: "body{}",
        },
      ],
      omissions: [],
      omitted: 0,
    })

    const { headers, parts } = parseArchive(archive)

    expect(headers["content-type"]).toContain("multipart/related")
    expect(headers["content-type"]).toContain('type="text/html"')
    expect(headers["snapshot-content-location"]).toBe("https://example.com/page")
    expect(headers["mime-version"]).toBe("1.0")
    expect(headers["x-trawl-archive"]).toBe("assembled-from-observed-subresources")
    expect(parts).toHaveLength(2)
    expect(parts[0].headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(parts[0].headers["content-location"]).toBe("https://example.com/page")
    expect(fromQuotedPrintable(parts[0].content).toString("utf8")).toBe("<html><body>main</body></html>")
    expect(parts[1].headers["content-location"]).toBe("https://example.com/app.css")
  })

  test("drops a subresource part that duplicates the main document", () => {
    const archive = assembleMhtml({
      url: "https://example.com/page",
      html: "<html></html>",
      parts: [
        {
          location: "https://example.com/page",
          contentType: "text/html",
          encoding: "quoted-printable",
          content: "stale",
        },
      ],
      omissions: [],
      omitted: 0,
    })

    expect(parseArchive(archive).parts).toHaveLength(1)
  })

  test("stays valid when parts were omitted, and says what is missing", () => {
    const archive = assembleMhtml({
      url: "https://example.com/page",
      html: "<html></html>",
      parts: [],
      omissions: [{ location: "https://example.com/huge.png", reason: "over-part-budget" }],
      omitted: 3,
    })

    const { headers, parts } = parseArchive(archive)

    expect(headers["x-trawl-omitted-resources"]).toBe("3")
    expect(parts).toHaveLength(2)
    expect(parts[1].headers["content-id"]).toBe("<trawl-omitted-resources@trawl.invalid>")
    const note = fromQuotedPrintable(parts[1].content).toString("utf8")
    expect(note).toContain("3 resource(s) omitted")
    expect(note).toContain("over-part-budget https://example.com/huge.png")
    expect(note).toContain("(2 further omissions not listed)")
  })

  test("cannot be talked into injecting a header line", () => {
    const archive = assembleMhtml({
      url: "https://example.com/a\r\nX-Injected: yes",
      html: "<html></html>",
      parts: [],
      omissions: [],
      omitted: 0,
    })

    expect(archive.split("\r\n").some((line) => line.startsWith("X-Injected"))).toBe(false)
    expect(parseArchive(archive).headers["snapshot-content-location"]).toBe(
      "https://example.com/a%0D%0AX-Injected: yes",
    )
  })

  test("emits pure ASCII, so the archive survives being written as text", () => {
    const archive = assembleMhtml({
      url: "https://example.com/páge",
      html: "<html><body>café ✓</body></html>",
      parts: [
        {
          location: "https://example.com/f.woff",
          contentType: "font/woff",
          encoding: "base64",
          content: "AAECAw==",
        },
      ],
      omissions: [],
      omitted: 0,
    })

    expect([...archive].every((char) => (char.codePointAt(0) ?? 0) < 0x80)).toBe(true)
  })

  test("bounds the complete serialized archive and drops whole trailing parts", () => {
    const document = {
      url: "https://example.com/",
      html: "<html><body>root</body></html>",
      parts: Array.from({ length: 4 }, (_, index) => ({
        location: `https://example.com/${index}.css`,
        contentType: "text/css",
        encoding: "quoted-printable" as const,
        content: "x".repeat(400),
      })),
      omissions: [],
      omitted: 0,
    }

    const archive = assembleBoundedMhtml(document, 1_500, 100)

    expect(archive).toBeDefined()
    expect((archive as string).length).toBeLessThanOrEqual(1_500)
    expect(Number(parseArchive(archive as string).headers["x-trawl-omitted-resources"])).toBeGreaterThan(0)
    expect(assembleBoundedMhtml({ ...document, html: "x".repeat(2_000), parts: [] }, 500, 100)).toBeUndefined()
  })
})

describe("subresource archiving", () => {
  test("attaches nothing and archives nothing without the flag", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, {})
    emitter.emit("response", resource("https://example.com/app.css", "stylesheet"))

    expect(emitter.listeners("response")).toBe(0)
    expect(await capture.drain()).toBeUndefined()
    expect(capture.archive("https://example.com/", PAGE_HTML)).toBeUndefined()
  })

  test("archives the renderable resource types and skips the rest", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit("response", resource("https://example.com/app.css", "stylesheet"))
    emitter.emit("response", resource("https://example.com/app.js", "script", { contentType: "text/javascript" }))
    emitter.emit(
      "response",
      resource("https://example.com/logo.png", "image", { contentType: "image/png", body: Buffer.from([1, 2, 3, 4]) }),
    )
    emitter.emit("response", resource("https://example.com/f.woff2", "font", { contentType: "font/woff2" }))
    emitter.emit("response", resource("https://example.com/frame.html", "document", { contentType: "text/html" }))
    emitter.emit("response", resource("https://example.com/api/items", "xhr", { contentType: "application/json" }))
    emitter.emit("response", resource("https://example.com/clip.mp4", "media", { contentType: "video/mp4" }))
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(headers["x-trawl-omitted-resources"]).toBeUndefined()
    expect(parts.map((part) => part.headers["content-location"])).toEqual([
      "https://example.com/",
      "https://example.com/app.css",
      "https://example.com/app.js",
      "https://example.com/logo.png",
      "https://example.com/f.woff2",
      "https://example.com/frame.html",
    ])
    expect(parts[1].headers["content-transfer-encoding"]).toBe("quoted-printable")
    expect(parts[3].headers["content-transfer-encoding"]).toBe("base64")
    expect(Buffer.from(parts[3].content, "base64").equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
  })

  test("archives a resource once however often the page refetches it", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit("response", resource("https://example.com/app.css", "stylesheet"))
    emitter.emit("response", resource("https://example.com/app.css", "stylesheet"))
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(parts).toHaveLength(2)
    expect(headers["x-trawl-omitted-resources"]).toBeUndefined()
  })

  test("skips redirects and error responses", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit("response", resource("https://example.com/moved.css", "stylesheet", { status: 302 }))
    emitter.emit("response", resource("https://example.com/gone.css", "stylesheet", { status: 404 }))
    await capture.drain()

    expect(parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string).parts).toHaveLength(1)
  })

  test("omits a part over the per-part budget on its declared length alone", async () => {
    const { page, emitter } = makePage()
    let read = false

    const capture = attachResponseCapture(page as never, { mhtml: true })
    const huge = resource("https://example.com/huge.css", "stylesheet", { contentLength: 3_000_000 })
    emitter.emit("response", {
      ...huge,
      body: async () => {
        read = true
        return Buffer.alloc(0)
      },
    })
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(read).toBe(false)
    expect(headers["x-trawl-omitted-resources"]).toBe("1")
    expect(fromQuotedPrintable(parts[1].content).toString("utf8")).toContain(
      "over-part-budget https://example.com/huge.css",
    )
  })

  test("omits a part whose real length overruns the budget", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit(
      "response",
      resource("https://example.com/huge.css", "stylesheet", { body: Buffer.alloc(2_097_153, 0x61) }),
    )
    await capture.drain()

    const { headers } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(headers["x-trawl-omitted-resources"]).toBe("1")
  })

  test("stops archiving once the whole-archive budget is spent", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { mhtml: true })
    for (let n = 0; n < 4; n++) {
      emitter.emit(
        "response",
        resource(`https://example.com/${n}.png`, "image", {
          contentType: "image/png",
          body: Buffer.alloc(2_097_152, n),
        }),
      )
    }
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(Number(headers["x-trawl-omitted-resources"])).toBeGreaterThan(0)
    expect(parts.length).toBeGreaterThan(1)
    expect(fromQuotedPrintable(parts.at(-1)?.content as string).toString("utf8")).toContain(
      "archive-budget-exhausted https://example.com/",
    )
  })

  test("bounds how many subresource reads are in flight at once", async () => {
    const { page, emitter } = makePage()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const capture = attachResponseCapture(page as never, { mhtml: true })
    for (let n = 0; n < 34; n++) {
      emitter.emit("response", {
        ...resource(`https://example.com/${n}.css`, "stylesheet"),
        body: async () => {
          await gate
          return Buffer.from("body{color:red}")
        },
      })
    }
    release()
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(parts).toHaveLength(34)
    expect(headers["x-trawl-omitted-resources"]).toBe("2")
    expect(fromQuotedPrintable(parts.at(-1)?.content as string).toString("utf8")).toContain(
      "read-slots-busy https://example.com/32.css",
    )
  })

  test("refuses a burst on its declared lengths, before any body is read", async () => {
    const { page, emitter } = makePage()
    const reads: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const capture = attachResponseCapture(page as never, { mhtml: true })
    for (let n = 0; n < 5; n++) {
      const url = `https://example.com/${n}.png`
      emitter.emit("response", {
        ...resource(url, "image", { contentType: "image/png", contentLength: 2_097_152 }),
        body: async () => {
          reads.push(url)
          await gate
          return Buffer.alloc(16, n)
        },
      })
    }
    release()
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(reads).toHaveLength(4)
    expect(headers["x-trawl-omitted-resources"]).toBe("1")
    expect(fromQuotedPrintable(parts.at(-1)?.content as string).toString("utf8")).toContain(
      "archive-budget-exhausted https://example.com/4.png",
    )
  })

  test("does not read unknown-size or compressed bodies", async () => {
    const { page, emitter } = makePage()
    let reads = 0
    const unreadable = (url: string, options: { contentLength?: number | null; contentEncoding?: string }) => ({
      ...resource(url, "stylesheet", options),
      body: async () => {
        reads++
        return Buffer.from("body{}")
      },
    })

    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit("response", unreadable("https://example.com/unknown.css", { contentLength: null }))
    emitter.emit("response", unreadable("https://example.com/compressed.css", { contentEncoding: "br" }))
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(reads).toBe(0)
    expect(headers["x-trawl-omitted-resources"]).toBe("2")
    const note = fromQuotedPrintable(parts.at(-1)?.content as string).toString("utf8")
    expect(note).toContain("unknown-content-length https://example.com/unknown.css")
    expect(note).toContain("unsafe-content-encoding https://example.com/compressed.css")
  })

  test("records a part whose body cannot be read", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit(
      "response",
      resource("https://example.com/app.css", "stylesheet", { body: new Error("target closed") }),
    )
    await capture.drain()

    const { headers, parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)

    expect(headers["x-trawl-omitted-resources"]).toBe("1")
    expect(fromQuotedPrintable(parts[1].content).toString("utf8")).toContain(
      "body-read-failed https://example.com/app.css",
    )
  })

  test("survives a response object that throws", async () => {
    const { page, emitter } = makePage()

    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit("response", {
      url: () => {
        throw new Error("response gone")
      },
    })
    await capture.drain()

    expect(
      parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string).headers["x-trawl-omitted-resources"],
    ).toBe("1")
  })

  test("leaves capturedResponses absent and never holds the page open", async () => {
    const { page } = makePage()
    const capture = attachResponseCapture(page as never, { mhtml: true })

    const started = Date.now()
    await capture.settle(30_000)

    expect(Date.now() - started).toBeLessThan(500)
    expect(await capture.drain()).toBeUndefined()
  })

  test("archives alongside pattern capture off one listener", async () => {
    const { page, emitter } = makePage()
    let reads = 0

    const capture = attachResponseCapture(page as never, { mhtml: true, captureResponses: ["app.css"] })
    emitter.emit("response", {
      ...resource("https://example.com/app.css", "stylesheet"),
      body: async () => {
        reads++
        return Buffer.from("body{color:red}")
      },
    })

    expect(emitter.listeners("response")).toBe(1)

    const entries = await capture.drain()

    expect(entries?.map((entry) => entry.url)).toEqual(["https://example.com/app.css"])
    expect(parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string).parts).toHaveLength(2)
    expect(reads).toBe(1)
  })

  test("does not add a body that finishes after the drain budget", async () => {
    const { page, emitter } = makePage()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const capture = attachResponseCapture(page as never, { mhtml: true })
    emitter.emit("response", {
      ...resource("https://example.com/late.css", "stylesheet"),
      body: async () => {
        await gate
        return Buffer.from("body{}")
      },
    })

    await capture.drain(0)
    release()
    await Promise.resolve()

    const { parts } = parseArchive(capture.archive("https://example.com/", PAGE_HTML) as string)
    expect(parts.map((part) => part.headers["content-location"])).toEqual(["https://example.com/"])
  })
})

describe("browser tiers", () => {
  const shell = (emit: Emitter["emit"]) => {
    emit("response", documentResponse("https://example.com/landed"))
    emit("response", resource("https://example.com/app.css", "stylesheet"))
  }

  test("Tier 2 returns an archive only when asked", async () => {
    const requested = makePage(shell)
    const withArchive = await runTier2(
      "https://example.com",
      poolHandle(requested.page),
      session,
      4_000,
      {},
      "GET",
      "",
      undefined,
      false,
      { mhtml: true },
    )

    expect(withArchive.status).toBe("success")
    const { parts } = parseArchive(withArchive.mhtml as string)
    // The main document response is dropped in favour of the rendered DOM at the same URL.
    expect(parts.map((part) => part.headers["content-location"])).toEqual([
      "https://example.com/landed",
      "https://example.com/app.css",
    ])
    expect(fromQuotedPrintable(parts[0].content).toString("utf8")).toBe(PAGE_HTML)
    expect(withArchive.capturedResponses).toBeUndefined()

    const untouched = makePage(shell)
    const withoutArchive = await runTier2("https://example.com", poolHandle(untouched.page), session, 4_000)

    expect(withoutArchive.status).toBe("success")
    expect(withoutArchive.mhtml).toBeUndefined()
    // Only the main-document tracker's listener — the archive attached nothing.
    expect(untouched.emitter.listeners("response")).toBe(1)
    expect(requested.emitter.listeners("response")).toBe(1)
  })

  test("Tier 2 omits MHTML for a non-HTML main response", async () => {
    const binary = makePage((emit) => {
      emit("response", {
        ...resource("https://example.com/file.png", "document", {
          contentType: "image/png",
          body: Buffer.from([1, 2, 3]),
        }),
        request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame, resourceType: () => "document" }),
      })
    })

    const result = await runTier2(
      "https://example.com/file.png",
      poolHandle(binary.page),
      session,
      4_000,
      {},
      "GET",
      "",
      undefined,
      false,
      { mhtml: true },
    )

    expect(result.status).toBe("success")
    expect(result.contentType).toBe("image/png")
    expect(result.mhtml).toBeUndefined()
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

  test("passes the flag through and returns the archive", async () => {
    const attempts: unknown[] = []
    const { page } = makePage((emit) => {
      emit("response", documentResponse("https://example.com/landed"))
      emit("response", resource("https://example.com/app.css", "stylesheet"))
    })

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 2, maxTimeout: 4_000, mhtml: true },
      { ...depsFor(page), onTierAttempt: (attempt) => attempts.push(attempt) },
    )

    expect(result.tier).toBe(2)
    expect(result.mhtml).toContain("multipart/related")
    expect(result.mhtml).toContain("Content-Location: https://example.com/app.css")
    expect(result.timings.every((timing) => !("mhtml" in timing))).toBe(true)
    expect(attempts.every((attempt) => !("mhtml" in (attempt as object)))).toBe(true)
  })

  test("omits the field entirely by default", async () => {
    const { page, emitter } = makePage((emit) => {
      emit("response", resource("https://example.com/app.css", "stylesheet"))
    })

    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 2, maxTimeout: 4_000 },
      depsFor(page),
    )

    expect(result.tier).toBe(2)
    expect(result.mhtml).toBeUndefined()
    expect(emitter.listeners("response")).toBe(1)
  })

  test("passes MHTML through Tier 3 without adding it to timings", async () => {
    const { page } = makePage()
    const result = await scrape(
      { url: "https://example.com", skipHttp: true, maxTier: 3, mhtml: true },
      { ...depsFor(page), loadSession: async () => undefined },
      {
        tier3: async (_url, _handle, _timeout, _proxy, _headers, _method, _body, _validator, _screenshot, capture) => {
          expect(capture?.mhtml).toBe(true)
          return { tier: 3, status: "success", durationMs: 1, html: PAGE_HTML, mhtml: "tier-3-archive" }
        },
      },
    )

    expect(result.mhtml).toBe("tier-3-archive")
    expect(result.timings.every((timing) => !("mhtml" in timing))).toBe(true)
  })

  test("passes MHTML through Tier 4 without adding it to timings", async () => {
    const { page } = makePage()
    const result = await scrape(
      {
        url: "https://example.com",
        skipHttp: true,
        maxTier: 4,
        proxy: "http://proxy.example:8080",
        mhtml: true,
      },
      depsFor(page),
      {
        tier3: async () => ({ tier: 3, status: "blocked", durationMs: 1, reason: "challenge" }),
        tier4: async (_url, _handle, _timeout, _proxy, _headers, _method, _body, _validator, _screenshot, capture) => {
          expect(capture?.mhtml).toBe(true)
          return { tier: 4, status: "success", durationMs: 1, html: PAGE_HTML, mhtml: "tier-4-archive" }
        },
      },
    )

    expect(result.mhtml).toBe("tier-4-archive")
    expect(result.timings.every((timing) => !("mhtml" in timing))).toBe(true)
  })
})
