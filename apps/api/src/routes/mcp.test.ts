import { describe, expect, test } from "bun:test"
import { PoolExhaustedError } from "@trawl/browser"
import { ScrapeError } from "@trawl/tiers"
import type { ScrapeResult } from "@trawl/types"
import { MetricsStore } from "../metrics"
import { MCP_HTML_MAX_CHARS, mcpRoute } from "./mcp"

const baseResult: ScrapeResult = {
  url: "https://1.1.1.1/final",
  html: "<html>ok</html>",
  cookies: [
    { name: "secret", value: "cookie", domain: "1.1.1.1", path: "/", expires: 0, httpOnly: true, secure: true },
  ],
  userAgent: "secret-agent",
  statusCode: 200,
  tier: 2,
  sessionCached: true,
  timings: [{ tier: 1, status: "blocked", durationMs: 2 }],
  totalMs: 12,
  contentType: "text/html; charset=utf-8",
}

function rpc(method: string, params?: unknown, id = 1): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  })
}

describe("MCP route", () => {
  test("records scrape calls rejected before the browser pool is ready", async () => {
    const metricsStore = new MetricsStore()
    const app = mcpRoute({ poolReady: () => false, metricsStore })
    const response = await app.handle(rpc("tools/call", { name: "scrape_url", arguments: { url: "https://1.1.1.1" } }))
    expect(response.status).toBe(200)
    expect((await response.json()).result.isError).toBe(true)
    expect(metricsStore.snapshot().recentEvents[0]).toMatchObject({ source: "mcp", domain: "1.1.1.1", success: false })
    metricsStore.close()
  })
  test("initializes and lists the focused tool set with the compatibility alias", async () => {
    const app = mcpRoute({ poolReady: () => true, runScrape: async () => baseResult })
    const initialized = await app.handle(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    )
    expect(initialized.status).toBe(200)
    expect((await initialized.json()).result.serverInfo.name).toBe("trawl")

    const listed = await app.handle(rpc("tools/list"))
    expect(listed.status).toBe(200)
    const body = await listed.json()
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "scrape",
      "scrape_url",
      "read",
      "extract",
      "screenshot",
      "inspect",
    ])
  })

  test("exposes the Streamable HTTP GET channel", async () => {
    const app = mcpRoute({ poolReady: () => true, runScrape: async () => baseResult })
    const response = await app.handle(new Request("http://localhost/mcp", { headers: { accept: "text/event-stream" } }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    await response.body?.cancel()
  })

  test("scrapes with safe arguments, truncates HTML, and omits secrets", async () => {
    let received: unknown
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async (input) => {
        received = input
        return {
          ...baseResult,
          html: `secret-cookie-${"x".repeat(MCP_HTML_MAX_CHARS)}`,
          timings: [
            {
              ...baseResult.timings[0],
              html: "private-timing-html",
              responseHeaders: { "set-cookie": "private-timing-cookie" },
            },
          ],
        }
      },
    })
    const response = await app.handle(
      rpc("tools/call", { name: "scrape_url", arguments: { url: "https://1.1.1.1", maxTier: 3, skipHttp: true } }),
    )
    const body = await response.json()
    expect(received).toEqual({ url: "https://1.1.1.1", maxTier: 3, skipHttp: true })
    expect(body.result.structuredContent).toEqual({
      url: baseResult.url,
      statusCode: 200,
      tier: 2,
      contentType: "text/html; charset=utf-8",
      totalMs: 12,
      truncated: true,
      sessionCached: true,
      timings: baseResult.timings,
    })
    expect(body.result.content[0].text.length).toBe(MCP_HTML_MAX_CHARS)
    expect(JSON.stringify(body)).not.toContain('cookie"')
    expect(JSON.stringify(body)).not.toContain("secret-agent")
    expect(JSON.stringify(body)).not.toContain("private-timing-html")
    expect(JSON.stringify(body)).not.toContain("private-timing-cookie")
  })

  test("extracts readable markdown with metadata and a caller-controlled limit", async () => {
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async () => ({
        ...baseResult,
        html: `<!doctype html><html lang="en"><head><title>Ignored shell title</title></head><body><article><h1>Useful title</h1><p>${"Readable content ".repeat(40)}</p></article></body></html>`,
      }),
    })
    const response = await app.handle(
      rpc("tools/call", {
        name: "read",
        arguments: { url: "https://1.1.1.1/article", format: "markdown", maxCharacters: 80 },
      }),
    )
    const result = (await response.json()).result
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain("Useful title")
    expect(result.content[0].text.length).toBe(80)
    expect(result.structuredContent).toMatchObject({ format: "markdown", characters: 80, truncated: true })
  })

  test("passes plain-text documents through untouched instead of readability-parsing them", async () => {
    const source = '  const settings = a_b\r\n\r\n\r\nif (value < 3 && value > 1) log("<done>")  \n'
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async () => ({ ...baseResult, html: source, contentType: "text/plain; charset=utf-8" }),
    })
    const response = await app.handle(
      rpc("tools/call", { name: "read", arguments: { url: "https://1.1.1.1/raw.txt" } }),
    )
    const result = (await response.json()).result
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe(source)
    expect(result.structuredContent).toMatchObject({
      title: baseResult.url,
      format: "markdown",
      characters: source.length,
      truncated: false,
    })
  })

  test.each(["markdown", "text"])("preserves empty text documents in %s format", async (format) => {
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async () => ({ ...baseResult, html: "", contentType: "text/plain" }),
    })
    const response = await app.handle(
      rpc("tools/call", { name: "read", arguments: { url: "https://1.1.1.1/empty.txt", format } }),
    )
    const result = (await response.json()).result
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe("")
    expect(result.structuredContent).toMatchObject({ format, characters: 0, truncated: false })
  })

  test("applies the character limit to raw text without stripping whitespace", async () => {
    const source = "  alpha\r\n\r\nbeta  "
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async () => ({ ...baseResult, html: source, contentType: "text/plain" }),
    })
    const response = await app.handle(
      rpc("tools/call", {
        name: "read",
        arguments: { url: "https://1.1.1.1/raw.txt", format: "text", maxCharacters: 10 },
      }),
    )
    const result = (await response.json()).result
    expect(result.content[0].text).toBe(source.slice(0, 10))
    expect(result.structuredContent).toMatchObject({ characters: 10, truncated: true })
  })

  test("returns screenshots as MCP image content and forces a browser tier", async () => {
    let received: unknown
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async (input) => {
        received = input
        return { ...baseResult, screenshot: "aGVsbG8=" }
      },
    })
    const response = await app.handle(
      rpc("tools/call", { name: "screenshot", arguments: { url: "https://1.1.1.1", maxTier: 3 } }),
    )
    const result = (await response.json()).result
    expect(received).toEqual({ url: "https://1.1.1.1", maxTier: 3, skipHttp: true, screenshot: true })
    expect(result.content[0]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" })
    expect(result.structuredContent.mimeType).toBe("image/jpeg")
  })

  test("passes bounded full-page screenshot options to the browser", async () => {
    let received: unknown
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async (input) => {
        received = input
        return { ...baseResult, screenshot: "aGVsbG8=" }
      },
    })
    const response = await app.handle(
      rpc("tools/call", {
        name: "screenshot",
        arguments: { url: "https://1.1.1.1", fullPage: true, waitForSelector: ".loaded" },
      }),
    )
    expect((await response.json()).result.content[0].type).toBe("image")
    expect(received).toEqual({
      url: "https://1.1.1.1",
      skipHttp: true,
      screenshot: true,
      screenshotFullPage: true,
      screenshotWaitForSelector: ".loaded",
    })
  })

  test("captures a selected element and rejects a full-page combination", async () => {
    let received: unknown
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async (input) => {
        received = input
        return { ...baseResult, screenshot: "aGVsbG8=" }
      },
    })
    const selected = await app.handle(
      rpc("tools/call", {
        name: "screenshot",
        arguments: { url: "https://1.1.1.1", selector: ".chart" },
      }),
    )
    expect((await selected.json()).result.content[0].type).toBe("image")
    expect(received).toEqual({
      url: "https://1.1.1.1",
      skipHttp: true,
      screenshot: true,
      screenshotSelector: ".chart",
    })

    const combined = await app.handle(
      rpc("tools/call", {
        name: "screenshot",
        arguments: { url: "https://1.1.1.1", selector: ".chart", fullPage: true },
      }),
    )
    expect((await combined.json()).result.isError).toBe(true)
  })

  test("extracts repeated records with text and attributes", async () => {
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async () => ({
        ...baseResult,
        html: '<html><body><div class="card"><h2>First</h2><a href="/one">Open</a></div><div class="card"><h2>Second</h2></div></body></html>',
      }),
    })
    const response = await app.handle(
      rpc("tools/call", {
        name: "extract",
        arguments: {
          url: "https://1.1.1.1",
          itemSelector: ".card",
          fields: { title: { selector: "h2" }, link: { selector: "a", attribute: "href" } },
          maxItems: 1,
        },
      }),
    )
    const result = (await response.json()).result
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent.items).toEqual([{ title: "First", link: "/one" }])
    expect(result.structuredContent).toMatchObject({ matched: 2, truncated: true })
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent.items)
  })

  test("extracts one document record and marks missing fields null", async () => {
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async () => ({ ...baseResult, html: "<html><body><h1>Title</h1></body></html>" }),
    })
    const response = await app.handle(
      rpc("tools/call", {
        name: "extract",
        arguments: {
          url: "https://1.1.1.1",
          fields: { title: { selector: "h1" }, missing: { selector: "a", attribute: "href" } },
        },
      }),
    )
    expect((await response.json()).result.structuredContent.items).toEqual([{ title: "Title", missing: null }])
  })

  test("uses a browser and waits for rendered extraction content when requested", async () => {
    let received: unknown
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async (input) => {
        received = input
        return { ...baseResult, html: "<html><body><div class=card><span>Ready</span></div></body></html>" }
      },
    })
    const response = await app.handle(
      rpc("tools/call", {
        name: "extract",
        arguments: {
          url: "https://1.1.1.1",
          waitForSelector: ".card",
          itemSelector: ".card",
          fields: { text: { selector: "span" } },
        },
      }),
    )
    const result = (await response.json()).result
    expect(result.isError).toBeUndefined()
    expect(received).toEqual({
      url: "https://1.1.1.1",
      skipHttp: true,
      contentWaitForSelector: ".card",
    })
    expect(result.structuredContent.items).toEqual([{ text: "Ready" }])
  })

  test("rejects rendering when maxTier excludes browser tiers", async () => {
    const app = mcpRoute({ poolReady: () => true, runScrape: async () => baseResult })
    const response = await app.handle(
      rpc("tools/call", {
        name: "extract",
        arguments: { url: "https://1.1.1.1", render: true, maxTier: 1, fields: { title: { selector: "h1" } } },
      }),
    )
    expect((await response.json()).result.isError).toBe(true)
  })

  test("renders extraction without a selector wait when requested", async () => {
    let received: unknown
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async (input) => {
        received = input
        return { ...baseResult, html: "<html><body><h1>Rendered</h1></body></html>" }
      },
    })
    const response = await app.handle(
      rpc("tools/call", {
        name: "extract",
        arguments: { url: "https://1.1.1.1", render: true, fields: { title: { selector: "h1" } } },
      }),
    )
    expect((await response.json()).result.structuredContent.items).toEqual([{ title: "Rendered" }])
    expect(received).toEqual({ url: "https://1.1.1.1", skipHttp: true })
  })

  test("rejects extraction limits and malformed selectors", async () => {
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async () => ({ ...baseResult, html: "<html><body><h1>Title</h1></body></html>" }),
    })
    const tooMany = await app.handle(
      rpc("tools/call", {
        name: "extract",
        arguments: { url: "https://1.1.1.1", fields: { title: { selector: "h1" } }, maxItems: 101 },
      }),
    )
    expect((await tooMany.json()).result.isError).toBe(true)

    const malformed = await app.handle(
      rpc("tools/call", {
        name: "extract",
        arguments: { url: "https://1.1.1.1", itemSelector: "[", fields: { title: { selector: "h1" } } },
      }),
    )
    expect((await malformed.json()).result.isError).toBe(true)
  })

  test("returns browser diagnostics while redacting URL credentials and query strings", async () => {
    let received: unknown
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: async (input) => {
        received = input
        return {
          ...baseResult,
          consoleLogs: [{ level: "SEVERE", message: "boom", timestamp: 1, source: "error" }],
          networkLogs: [
            {
              name: "https://user:secret@example.com/api?token=secret#part",
              entryType: "resource",
              startTime: 1,
              duration: 2,
              initiatorType: "fetch",
              transferSize: 3,
              encodedBodySize: 2,
              decodedBodySize: null,
            },
          ],
          redirectChain: ["https://example.com/start?token=secret", "https://example.com/final#private"],
        }
      },
    })
    const response = await app.handle(rpc("tools/call", { name: "inspect", arguments: { url: "https://1.1.1.1" } }))
    const result = (await response.json()).result
    expect(received).toEqual({
      url: "https://1.1.1.1",
      skipHttp: true,
      consoleLogs: true,
      networkLogs: true,
      redirectChain: true,
    })
    expect(result.structuredContent.networkLogs[0].name).toBe("https://example.com/api")
    expect(result.structuredContent.redirectChain).toEqual(["https://example.com/start", "https://example.com/final"])
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("rejects extra arguments, private targets, and disallowed origins", async () => {
    const app = mcpRoute({
      allowedOrigins: ["https://chat.example"],
      poolReady: () => true,
      runScrape: async () => baseResult,
    })
    const forbidden = await app.handle(
      rpc("tools/call", {
        name: "scrape_url",
        arguments: { url: "https://1.1.1.1", headers: { authorization: "secret" } },
      }),
    )
    expect((await forbidden.json()).result.isError).toBe(true)

    const privateTarget = await app.handle(
      rpc("tools/call", { name: "scrape_url", arguments: { url: "http://127.0.0.1" } }),
    )
    expect((await privateTarget.json()).result).toMatchObject({ isError: true })

    const originRequest = rpc("tools/list")
    originRequest.headers.set("origin", "https://evil.example")
    expect((await app.handle(originRequest)).status).toBe(403)
  })

  test("returns scrape, timeout, and pool failures as MCP tool errors", async () => {
    const failures = [
      new ScrapeError("All tiers exhausted. Last failure: blocked", [
        { tier: 1 as const, status: "blocked" as const, durationMs: 3 },
      ]),
      new ScrapeError("Scrape timed out after 1000ms", [
        { tier: 1 as const, status: "timeout" as const, durationMs: 1000 },
      ]),
      new PoolExhaustedError(),
    ]

    for (const failure of failures) {
      const app = mcpRoute({
        poolReady: () => true,
        runScrape: async () => {
          throw failure
        },
      })
      const response = await app.handle(
        rpc("tools/call", { name: "scrape_url", arguments: { url: "https://1.1.1.1" } }),
      )
      const result = (await response.json()).result
      expect(result.isError).toBe(true)
      expect(result.content[0].text.length).toBeGreaterThan(0)
    }
  })
})

test("MCP forwards a named session for every page tool and rejects invalid IDs", async () => {
  const received: string[] = []
  const app = mcpRoute({
    poolReady: () => true,
    runScrape: async (input) => {
      received.push(input.sessionId ?? "missing")
      return {
        ...baseResult,
        screenshot: Buffer.from("owned-jpeg").toString("base64"),
        consoleLogs: [],
        networkLogs: [],
        redirectChain: [],
      }
    },
  })
  for (const name of ["scrape", "read", "extract", "screenshot", "inspect"]) {
    const response = await app.handle(
      rpc("tools/call", {
        name,
        arguments: {
          url: "https://1.1.1.1",
          sessionId: "account",
          ...(name === "extract" ? { itemSelector: "html", fields: { text: { selector: "html" } } } : {}),
        },
      }),
    )
    const body = await response.json()
    expect(body, `${name}: ${JSON.stringify(body)}`).toHaveProperty("result")
    expect(body.result.isError).not.toBe(true)
  }
  expect(received).toEqual(["account", "account", "account", "account", "account"])
  const invalid = await app.handle(
    rpc("tools/call", { name: "read", arguments: { url: "https://1.1.1.1", sessionId: "../invalid" } }),
  )
  expect((await invalid.json()).result.isError).toBe(true)
  expect(received).toHaveLength(5)
})
