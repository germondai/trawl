import { describe, expect, test } from "bun:test"
import type net from "node:net"
import { PassThrough } from "node:stream"
import type { BrowserHandle } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { writeResponseFromBuffer } from "../httpResponse"
import { serveViaScrape, shouldBypassTier0 } from "../server"

describe("always-scrape Tier 0 policy", () => {
  test("is opt-in and preserves the existing challenge-cache bypass", () => {
    expect(shouldBypassTier0(undefined, undefined)).toBe(false)
    expect(shouldBypassTier0(false, "direct")).toBe(false)
    expect(shouldBypassTier0(false, "cf")).toBe(true)
    expect(shouldBypassTier0(true, undefined)).toBe(true)
    expect(shouldBypassTier0(true, "direct")).toBe(true)
  })
})

describe("writeResponseFromBuffer — Set-Cookie newline folding", () => {
  test("emits one Set-Cookie line per cookie when Playwright newline-folds them", () => {
    // Playwright's response.allHeaders() joins multiple Set-Cookie values with \n.
    // A bare value after the fold creates a 'malformed MIME header line' error in
    // strict HTTP/1.1 clients (e.g. Go's net/http) when the Expires date contains
    // a comma.
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    const cookieA = "session-id=abc; Domain=.example.com; Path=/; Secure"
    const cookieB =
      "session-id-time=123456789l; Domain=.example.com; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Path=/; Secure"

    writeResponseFromBuffer(
      stream as unknown as net.Socket,
      200,
      { "set-cookie": `${cookieA}\n${cookieB}`, "content-type": "text/html" },
      Buffer.from("ok"),
      "text/html",
    )

    const raw = Buffer.concat(chunks).toString("latin1")
    const lines = raw.split("\r\n")
    const cookieLines = lines.filter((l) => l.toLowerCase().startsWith("set-cookie:"))

    // Must produce two separate header lines, not one line with an embedded newline.
    expect(cookieLines).toHaveLength(2)
    expect(cookieLines[0]).toContain("session-id=abc")
    expect(cookieLines[1]).toContain("session-id-time=")

    // No bare continuation line — the Expires comma must not produce a split.
    const malformed = lines.filter((l) => /^session-id-time=/.test(l))
    expect(malformed).toHaveLength(0)
  })

  test("passes through a single-value Set-Cookie header unchanged", () => {
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    writeResponseFromBuffer(
      stream as unknown as net.Socket,
      200,
      { "set-cookie": "token=xyz; Path=/; HttpOnly", "content-type": "text/html" },
      Buffer.from("ok"),
      "text/html",
    )

    const raw = Buffer.concat(chunks).toString("latin1")
    const lines = raw.split("\r\n")
    const cookieLines = lines.filter((l) => l.toLowerCase().startsWith("set-cookie:"))
    expect(cookieLines).toHaveLength(1)
    expect(cookieLines[0]).toContain("token=xyz")
  })
})

describe("serveViaScrape error handling", () => {
  const WALL_HTML =
    '<html><head><title>Challenge</title></head><body><form id="challenge-form">blocked</form></body></html>'

  const mockBlockedDeps = (status = 403, html = WALL_HTML, headers: Record<string, string> = {}): OrchestratorDeps => {
    const mainFrame = {}
    const wallPage = {
      url: () => "https://example.com/blocked",
      title: async () => (status === 200 ? "Results" : "Access denied"),
      content: async () => html,
      goto: async () => {},
      on: (event: string, handler: (response: unknown) => void) => {
        if (event !== "response") return
        handler({
          url: () => "https://example.com/blocked",
          status: () => status,
          headers: () => headers,
          allHeaders: async () => headers,
          body: async () => Buffer.from(html),
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

    return {
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
      loadSession: async () => ({ cookies: [], userAgent: "test-agent", savedAt: 1 }),
      saveSession: async () => {},
      invalidateSession: async () => {},
      minTier: 2,
    }
  }

  test("writes solved legacy-encoded HTML as a UTF-8 HTTP response", async () => {
    const html = `<html><body><h1>Рик и Морти</h1><p>${"Результаты поиска. ".repeat(10)}</p></body></html>`
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    await serveViaScrape(stream as unknown as net.Socket, "https://example.com/blocked", "GET", {}, undefined, {
      port: 8192,
      host: "127.0.0.1",
      caDir: "",
      maxTier: 2,
      maxTimeout: 2000,
      deps: mockBlockedDeps(200, html, {
        "content-type": "text/html; charset=windows-1251",
        "content-encoding": "gzip",
        "content-length": "999",
        "set-cookie": "session=value",
      }),
    })
    const raw = Buffer.concat(chunks)
    const boundary = raw.indexOf("\r\n\r\n")
    expect(boundary).toBeGreaterThan(0)
    const head = raw.subarray(0, boundary).toString("latin1").toLowerCase()
    const body = raw.subarray(boundary + 4)
    expect(head).toContain("http/1.1 200 ok")
    expect(head).toContain("content-type: text/html; charset=utf-8")
    expect(head).toContain(`content-length: ${body.length}`)
    expect(head).toContain("set-cookie: session=value")
    expect(head).not.toContain("content-encoding:")
    expect(new TextDecoder("utf-8").decode(body)).toBe(html)
  })

  test("passes through challenge wall with original status and headers when scrape fails on a wall", async () => {
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    await serveViaScrape(stream as unknown as net.Socket, "https://example.com/blocked", "GET", {}, undefined, {
      port: 8192,
      host: "127.0.0.1",
      caDir: "",
      maxTier: 2,
      maxTimeout: 2000,
      deps: mockBlockedDeps(403),
    })

    const raw = Buffer.concat(chunks).toString("utf8")
    expect(raw).toContain("HTTP/1.1 403 Forbidden")
    expect(raw).toContain("x-trawl-status: blocked")
    expect(raw).toContain(WALL_HTML)
    expect(raw).not.toContain("502 Bad Gateway")
  })

  test("preserves non-403 challenge statuses (e.g. DuckDuckGo HTTP 202)", async () => {
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    await serveViaScrape(stream as unknown as net.Socket, "https://example.com/blocked", "GET", {}, undefined, {
      port: 8192,
      host: "127.0.0.1",
      caDir: "",
      maxTier: 2,
      maxTimeout: 2000,
      deps: mockBlockedDeps(202),
    })

    const raw = Buffer.concat(chunks).toString("utf8")
    expect(raw).toContain("HTTP/1.1 202 Accepted")
    expect(raw).toContain("x-trawl-status: blocked")
    expect(raw).toContain(WALL_HTML)
    expect(raw).not.toContain("502 Bad Gateway")
  })

  test("synthesizes 502 Bad Gateway on generic infrastructure errors without blockedEvidence", async () => {
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    const failingDeps: OrchestratorDeps = {
      acquireBrowser: async () => {
        throw new Error("Pool acquisition failed")
      },
      releaseBrowser: () => {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
      minTier: 2,
    }

    await serveViaScrape(stream as unknown as net.Socket, "https://example.com/error", "GET", {}, undefined, {
      port: 8192,
      host: "127.0.0.1",
      caDir: "",
      maxTier: 2,
      maxTimeout: 2000,
      deps: failingDeps,
    })

    const raw = Buffer.concat(chunks).toString("utf8")
    expect(raw).toContain("HTTP/1.1 502 Bad Gateway")
    expect(raw).toContain("TRAWL proxy error: Pool acquisition failed")
  })

  test("does not return stale evidence when a later browser tier fails", async () => {
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    const deps = mockBlockedDeps(403)
    const acquireBrowser = deps.acquireBrowser
    deps.acquireBrowser = async (...args) => {
      const handle = await acquireBrowser(...args)
      const newPage = handle.context.newPage.bind(handle.context)
      let pageCount = 0
      handle.context.newPage = async () => {
        pageCount += 1
        if (pageCount > 1) throw new Error("fresh browser failed")
        return await newPage()
      }
      return handle
    }

    await serveViaScrape(stream as unknown as net.Socket, "https://example.com/blocked", "GET", {}, undefined, {
      port: 8192,
      host: "127.0.0.1",
      caDir: "",
      maxTier: 3,
      maxTimeout: 2000,
      deps,
    })

    const raw = Buffer.concat(chunks).toString("utf8")
    expect(raw).toContain("HTTP/1.1 502 Bad Gateway")
    expect(raw).toContain("TRAWL proxy error: Max tier reached without success")
    expect(raw).not.toContain(WALL_HTML)
    expect(raw).not.toContain("x-trawl-status: blocked")
  })
})
