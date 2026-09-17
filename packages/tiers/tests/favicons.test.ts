import { afterEach, describe, expect, test } from "bun:test"
import type { BrowserHandle, FaviconEntry, SessionData } from "@trawl/types"
import { capturePageFavicons } from "../src/favicons"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"

const PAGE_HTML = `<html><head><title>Ordinary Page</title></head><body>${"content ".repeat(20)}</body></html>`
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x61, 0x70, 0x65, 0x78])

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" }
const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

const globals = globalThis as any
const realGlobals = { document: globals.document, location: globals.location, fetch: globals.fetch }

afterEach(() => {
  // Restored rather than deleted: `fetch` is real in this runtime and other suites in the
  // same process need it back.
  globals.document = realGlobals.document
  globals.location = realGlobals.location
  globals.fetch = realGlobals.fetch
})

interface LinkStub {
  rel: string
  href: string | null
}

interface Served {
  status?: number
  contentType?: string
  contentLength?: string
  bytes?: Uint8Array
  throws?: string
}

/**
 * Runs the page function for real against a stand-in DOM. The resolution rules — apex
 * first, `rel` matched as a substring, relative hrefs against `<base>` — only exist
 * inside `page.evaluate`, so a stub that answers with canned entries would assert
 * nothing about them.
 */
const makePage = (options: {
  baseURI?: string
  origin?: string
  protocol?: string
  links?: LinkStub[]
  serve?: Record<string, Served>
  hang?: boolean
}) => {
  const requested: string[] = []
  const bodiesRead: string[] = []
  const serve = options.serve ?? {}
  const page = {
    url: () => `${options.origin ?? "https://example.test"}/landed`,
    title: async () => "Ordinary Page",
    content: async () => PAGE_HTML,
    goto: async () => {},
    on: () => {},
    mainFrame: () => ({}),
    frames: () => [],
    context: () => ({ cookies: async () => [] }),
    setExtraHTTPHeaders: async () => {},
    waitForLoadState: async () => {},
    close: async () => {},
    screenshot: async () => Buffer.from("jpeg"),
    evaluate: async (fn: any, arg?: any) => {
      // Tier 3/4 read the user agent through the same entry point.
      if (typeof fn === "function" && fn.length === 0) return "test-agent"
      if (options.hang) return await new Promise(() => {})
      const g = globals
      g.document = {
        baseURI: options.baseURI ?? `${options.origin ?? "https://example.test"}/landed`,
        querySelectorAll: (selector: string) => {
          expect(selector).toBe("link[rel]")
          return (options.links ?? []).map((link) => ({
            getAttribute: (name: string) => (name === "rel" ? link.rel : link.href),
          }))
        },
      }
      g.location = {
        protocol: options.protocol ?? "https:",
        origin: options.origin ?? "https://example.test",
      }
      g.fetch = async (url: string) => {
        requested.push(url)
        const served = serve[url]
        if (!served) throw new TypeError("NetworkError when attempting to fetch resource.")
        if (served.throws) throw new TypeError(served.throws)
        return {
          ok: (served.status ?? 200) < 400,
          status: served.status ?? 200,
          headers: {
            get: (name: string) => {
              if (name === "content-type") return served.contentType ?? null
              if (name === "content-length") return served.contentLength ?? null
              return null
            },
          },
          arrayBuffer: async () => {
            bodiesRead.push(url)
            return (served.bytes ?? new Uint8Array()).buffer
          },
        }
      }
      return await fn(arg)
    },
  }
  return { page, requested, bodiesRead }
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

describe("capturePageFavicons", () => {
  test("tries the apex /favicon.ico on a page that declares no icon", async () => {
    const { page, requested } = makePage({
      serve: { "https://example.test/favicon.ico": { contentType: "image/x-icon", bytes: ICO } },
    })

    const icons = await capturePageFavicons(page as any)

    expect(requested).toEqual(["https://example.test/favicon.ico"])
    expect(icons).toEqual([
      { url: "https://example.test/favicon.ico", contentType: "image/x-icon", data: ICO.toString("base64") },
    ])
  })

  test("puts the apex icon first and then the declared ones in document order", async () => {
    const { page, requested } = makePage({
      links: [
        { rel: "apple-touch-icon", href: "/touch.png" },
        { rel: "shortcut icon", href: "https://cdn.example.test/i.svg" },
      ],
      serve: {
        "https://example.test/favicon.ico": { bytes: ICO },
        "https://example.test/touch.png": { bytes: new Uint8Array([1]) },
        "https://cdn.example.test/i.svg": { bytes: new Uint8Array([2]) },
      },
    })

    const icons = await capturePageFavicons(page as any)

    expect(requested).toEqual([
      "https://example.test/favicon.ico",
      "https://example.test/touch.png",
      "https://cdn.example.test/i.svg",
    ])
    expect(icons.map((icon: FaviconEntry) => icon.url)).toEqual(requested)
  })

  test("fetches an apex icon the page also declares exactly once", async () => {
    const { page, requested } = makePage({
      links: [{ rel: "icon", href: "/favicon.ico" }],
      serve: { "https://example.test/favicon.ico": { bytes: ICO } },
    })

    const icons = await capturePageFavicons(page as any)

    expect(requested).toEqual(["https://example.test/favicon.ico"])
    expect(icons).toHaveLength(1)
  })

  test("resolves a relative href against the document base, not the landing url", async () => {
    const { page, requested } = makePage({
      baseURI: "https://example.test/assets/",
      links: [{ rel: "icon", href: "i.png" }],
      serve: {
        "https://example.test/favicon.ico": { throws: "404" },
        "https://example.test/assets/i.png": { bytes: new Uint8Array([3]) },
      },
    })

    await capturePageFavicons(page as any)

    expect(requested).toContain("https://example.test/assets/i.png")
  })

  test("fetches an inline data: icon and reports it by mime, not by its payload", async () => {
    const inline = "data:image/svg+xml;base64,PHN2Zy8+"
    const { page, requested } = makePage({
      links: [{ rel: "icon", href: inline }],
      serve: {
        "https://example.test/favicon.ico": { throws: "404" },
        [inline]: { contentType: "image/svg+xml", bytes: new Uint8Array([60, 115]) },
      },
    })

    const icons = await capturePageFavicons(page as any)

    // The href is fetched whole; repeating it in `url` next to the bytes decoded from it
    // would carry the payload twice.
    expect(requested).toContain(inline)
    expect(icons.map((icon: FaviconEntry) => icon.url)).toContain("data:image/svg+xml")
  })

  test("declines to read an inline icon that cannot decode to within the byte cap", async () => {
    const previous = process.env.FAVICON_MAX_BYTES
    process.env.FAVICON_MAX_BYTES = "8"
    try {
      const { capturePageFavicons: capped } = await import(`../src/favicons?inline-cap`)
      const inline = `data:image/png;base64,${"A".repeat(64)}`
      const { page, requested } = makePage({
        links: [{ rel: "icon", href: inline }],
        serve: { "https://example.test/favicon.ico": { throws: "404" } },
      })

      const icons = await capped(page as any)

      expect(requested).not.toContain(inline)
      expect(icons.find((icon: FaviconEntry) => icon.url === "data:image/png")?.error).toContain("cannot decode")
    } finally {
      if (previous === undefined) delete process.env.FAVICON_MAX_BYTES
      else process.env.FAVICON_MAX_BYTES = previous
    }
  })

  test("refuses an oversize icon on its declared length rather than reading it", async () => {
    // fetch() hands back whole bodies, so a read cannot be cut short once it starts.
    const previous = process.env.FAVICON_MAX_BYTES
    process.env.FAVICON_MAX_BYTES = "4"
    try {
      const { capturePageFavicons: capped } = await import(`../src/favicons?declared-length`)
      const { page, bodiesRead } = makePage({
        serve: { "https://example.test/favicon.ico": { contentLength: "9000", bytes: ICO } },
      })

      const icons = await capped(page as any)

      expect(bodiesRead).toEqual([])
      expect(icons).toEqual([{ url: "https://example.test/favicon.ico", error: "9000 bytes exceeds the 4 byte cap" }])
    } finally {
      if (previous === undefined) delete process.env.FAVICON_MAX_BYTES
      else process.env.FAVICON_MAX_BYTES = previous
    }
  })

  test("skips collection outright once the request's budget is spent", async () => {
    const { page, requested } = makePage({ serve: { "https://example.test/favicon.ico": { bytes: ICO } } })

    expect(await capturePageFavicons(page as any, 0)).toEqual([])
    expect(requested).toEqual([])
  })

  test("never outlives the budget the caller has left", async () => {
    const { page } = makePage({ hang: true })

    const started = Date.now()
    expect(await capturePageFavicons(page as any, 30)).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("drops a non-fetchable scheme rather than handing it to fetch", async () => {
    const { page, requested } = makePage({
      links: [
        { rel: "icon", href: "javascript:alert(1)" },
        { rel: "icon", href: "" },
        { rel: "icon", href: null },
      ],
      serve: { "https://example.test/favicon.ico": { bytes: ICO } },
    })

    await capturePageFavicons(page as any)

    expect(requested).toEqual(["https://example.test/favicon.ico"])
  })

  test("ignores a link whose rel is not an icon", async () => {
    const { page, requested } = makePage({
      links: [
        { rel: "stylesheet", href: "/site.css" },
        { rel: "preconnect", href: "https://cdn.example.test" },
      ],
      serve: { "https://example.test/favicon.ico": { bytes: ICO } },
    })

    await capturePageFavicons(page as any)

    expect(requested).toEqual(["https://example.test/favicon.ico"])
  })

  test("reports the status of an icon the origin refused instead of dropping it silently", async () => {
    const { page } = makePage({
      links: [{ rel: "icon", href: "/i.png" }],
      serve: {
        "https://example.test/favicon.ico": { status: 404 },
        "https://example.test/i.png": { status: 403 },
      },
    })

    const icons = await capturePageFavicons(page as any)

    expect(icons).toEqual([
      { url: "https://example.test/favicon.ico", error: "http-404" },
      { url: "https://example.test/i.png", error: "http-403" },
    ])
  })

  test("carries a fetch that threw as an error entry and keeps collecting", async () => {
    const { page } = makePage({
      links: [{ rel: "icon", href: "/i.png" }],
      serve: {
        "https://example.test/favicon.ico": { throws: "NetworkError" },
        "https://example.test/i.png": { bytes: ICO },
      },
    })

    const icons = await capturePageFavicons(page as any)

    expect(icons[0].error).toBe("NetworkError")
    expect(icons[1].data).toBe(ICO.toString("base64"))
  })

  test("drops a zero-byte icon, which is a 200 that carries nothing", async () => {
    const { page } = makePage({ serve: { "https://example.test/favicon.ico": { bytes: new Uint8Array() } } })

    const icons = await capturePageFavicons(page as any)

    expect(icons).toEqual([{ url: "https://example.test/favicon.ico", error: "empty body" }])
  })

  test("drops an icon past FAVICON_MAX_BYTES rather than carrying it", async () => {
    const previous = process.env.FAVICON_MAX_BYTES
    process.env.FAVICON_MAX_BYTES = "4"
    try {
      // The module reads its caps at import time, so the cap is re-read here.
      const { capturePageFavicons: capped } = await import(`../src/favicons?max-bytes`)
      const { page } = makePage({ serve: { "https://example.test/favicon.ico": { bytes: ICO } } })

      const icons = await capped(page as any)

      expect(icons[0].data).toBeUndefined()
      expect(icons[0].error).toContain("exceeds")
    } finally {
      if (previous === undefined) delete process.env.FAVICON_MAX_BYTES
      else process.env.FAVICON_MAX_BYTES = previous
    }
  })

  test("skips the apex icon on a non-http origin", async () => {
    const { page, requested } = makePage({ protocol: "file:", origin: "null" })

    const icons = await capturePageFavicons(page as any)

    expect(requested).toEqual([])
    expect(icons).toEqual([])
  })

  test("gives up on a page that never answers instead of holding the tier open", async () => {
    const previous = process.env.FAVICON_TIMEOUT_MS
    process.env.FAVICON_TIMEOUT_MS = "20"
    try {
      const { capturePageFavicons: impatient } = await import(`../src/favicons?timeout`)
      const { page } = makePage({ hang: true })

      expect(await impatient(page as any)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.FAVICON_TIMEOUT_MS
      else process.env.FAVICON_TIMEOUT_MS = previous
    }
  })

  test("returns [] when the evaluation itself throws", async () => {
    const page = {
      evaluate: async () => {
        throw new Error("Execution context was destroyed")
      },
    }

    expect(await capturePageFavicons(page as any)).toEqual([])
  })
})

describe("tiers", () => {
  const serve = { "https://example.test/favicon.ico": { contentType: "image/x-icon", bytes: ICO } }
  const expected = [
    { url: "https://example.test/favicon.ico", contentType: "image/x-icon", data: ICO.toString("base64") },
  ]

  test("tier 2 returns the favicons when asked", async () => {
    const { page } = makePage({ serve })
    const t2 = await runTier2(
      "https://example.test/",
      poolHandle(page),
      session,
      4_000,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { favicons: true },
    )

    expect(t2.status).toBe("success")
    expect(t2.favicons).toEqual(expected)
  })

  test("tier 3 returns the favicons when asked and nothing when not", async () => {
    const { page, requested } = makePage({ serve })
    const asked = await runTier3(
      "https://example.test/",
      freshHandle(page),
      4_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      {
        favicons: true,
      },
    )
    expect(asked.favicons).toEqual(expected)

    const quiet = makePage({ serve })
    const unasked = await runTier3(
      "https://example.test/",
      freshHandle(quiet.page),
      4_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      {},
    )
    expect(unasked.favicons).toBeUndefined()
    expect(quiet.requested).toEqual([])
    expect(requested).toHaveLength(1)
  })

  test("tier 4 returns the favicons when asked", async () => {
    const { page } = makePage({ serve })
    const t4 = await runTier4(
      "https://example.test/",
      freshHandle(page),
      4_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { favicons: true },
    )

    expect(t4.favicons).toEqual(expected)
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

  test("emits the tier's favicons on the scrape result when requested", async () => {
    const { page } = makePage({
      serve: { "https://example.test/favicon.ico": { contentType: "image/x-icon", bytes: ICO } },
    })

    const result = await scrape(
      { url: "https://example.test/", skipHttp: true, maxTier: 3, maxTimeout: 4_000, favicons: true },
      depsFor(page),
    )

    expect(result.tier).toBe(3)
    expect(result.favicons).toEqual([
      { url: "https://example.test/favicon.ico", contentType: "image/x-icon", data: ICO.toString("base64") },
    ])
  })

  test("omits the favicons by default and fetches nothing", async () => {
    const { page, requested } = makePage({ serve: { "https://example.test/favicon.ico": { bytes: ICO } } })

    const result = await scrape(
      { url: "https://example.test/", skipHttp: true, maxTier: 3, maxTimeout: 4_000 },
      depsFor(page),
    )

    expect(result.favicons).toBeUndefined()
    expect(requested).toEqual([])
  })
})
