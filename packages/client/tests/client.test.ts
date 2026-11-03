import { describe, expect, test } from "bun:test"
import { type Fetch, type ScrapeResponse, Trawl, TrawlError } from "../src/index"

const page: ScrapeResponse = {
  url: "https://target.example/article",
  html: "<article>Loaded content</article>",
  statusCode: 200,
  cookies: [],
  userAgent: "owned-agent",
  tier: 1,
  sessionCached: false,
  timings: [{ tier: 1, status: "success", durationMs: 1 }],
  totalMs: 1,
}

function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const client = new Trawl({
    baseURL: "https://api.example/prefix/",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request.clone())
      return handler(request)
    },
  })
  return { client, requests }
}

describe("TRAWL client", () => {
  test("forwards opt-in WAF detection and preserves metadata on success and failure", async () => {
    const waf = {
      engine: "wafmeow" as const,
      version: "3.1.0",
      state: "incomplete" as const,
      products: ["Cloudflare"],
      sourceTier: 1 as const,
    }
    const { client, requests } = fixture(() => Response.json({ ...page, waf }))
    expect((await client.scrape({ url: page.url, detectWaf: true })).waf).toEqual(waf)
    expect(await requests[0]?.json()).toMatchObject({ detectWaf: true })
    const failed = fixture(() => Response.json({ error: "blocked", waf }, { status: 500 })).client
    try {
      await failed.scrape({ url: page.url, detectWaf: true })
      throw new Error("Expected API failure")
    } catch (error) {
      expect(error).toBeInstanceOf(TrawlError)
      expect((error as TrawlError).waf).toEqual(waf)
    }
  })
  test.each([{ body: { query: "žluťoučký 🚀", nested: { active: true } } }, { body: ["one", { value: 2 }] }])(
    "serializes target JSON bodies without changing caller options",
    async ({ body }) => {
      const headers = { "X-Target": "owned" }
      const options = { url: page.url, method: "POST" as const, headers, body }
      const { client, requests } = fixture(() => Response.json(page))
      await client.scrape(options)
      const sent = await requests[0]?.json()
      expect(sent.body).toBe(JSON.stringify(body))
      expect(sent.headers).toEqual({ ...headers, "Content-Type": "application/json" })
      expect(options.body).toBe(body)
      expect(options.headers).toEqual({ "X-Target": "owned" })
      expect(requests[0]?.headers.get("content-type")).toBe("application/json")
      expect(requests[0]?.headers.has("x-target")).toBe(false)
    },
  )

  test("preserves explicit target Content-Type and raw request bodies", async () => {
    const { client, requests } = fixture(() => Response.json(page))
    const headers = { "cOnTent-TyPe": "application/vnd.owned+json; charset=utf-8" }
    await client.scrape({ url: page.url, method: "POST", body: { query: "owned" }, headers })
    expect(await requests[0]?.json()).toMatchObject({ body: '{"query":"owned"}', headers })
    for (const body of ["query=one%20two", "", '{"already":"serialized"}']) {
      const options = { url: page.url, method: "POST" as const, headers: { "Content-Type": "text/plain" }, body }
      await client.scrape(options)
      expect(await requests.at(-1)?.json()).toEqual(options)
    }
  })

  test("serializes JSON for content, browser helpers and session requests", async () => {
    const { client, requests } = fixture((request) =>
      Response.json({
        ...page,
        screenshot: "aGVsbG8=",
        ...(request.url.endsWith("/read")
          ? { title: "Owned", text: "Owned", format: "text", characters: 5, truncated: false, contentType: "text/html" }
          : {}),
        ...(request.url.endsWith("/extract")
          ? { items: [], matched: 0, truncated: false, contentType: "text/html" }
          : {}),
      }),
    )
    const options = { url: page.url, method: "POST" as const, body: { query: "owned" } }
    await client.read(options)
    await client.extract({ ...options, fields: { title: { selector: "h1" } } })
    await client.screenshot(options)
    await client.inspect(options)
    await client.sessions.scrape("owned-session", options)
    for (const request of requests)
      expect(await request.json()).toMatchObject({
        body: '{"query":"owned"}',
        headers: { "Content-Type": "application/json" },
      })
    expect(requests.at(-1)?.url).toEndWith("/sessions/owned-session/scrape")
  })

  test("rejects unsupported or unserializable target bodies before sending", async () => {
    const { client, requests } = fixture(() => Response.json(page))
    const circular: { self?: unknown } = {}
    circular.self = circular
    for (const body of [
      new FormData(),
      new URLSearchParams("a=1"),
      new Uint8Array([1]),
      new Date(),
      new Map(),
      circular,
      { value: 1n },
      { toJSON: () => undefined },
    ])
      await expect(client.scrape({ url: page.url, method: "POST", body })).rejects.toThrow(TypeError)
    expect(requests).toHaveLength(0)
  })

  test("reads and extracts through native endpoints with request options preserved", async () => {
    const { client, requests } = fixture((request) =>
      Response.json({
        url: page.url,
        statusCode: 200,
        tier: 1,
        contentType: "text/html",
        totalMs: 1,
        ...(request.url.endsWith("/read")
          ? { text: "Owned", title: "Title", format: "text", characters: 5, truncated: false }
          : { items: [{ title: "Owned" }], matched: 1, truncated: false }),
      }),
    )
    expect((await client.read({ url: page.url, format: "text", sessionId: "owned" })).text).toBe("Owned")
    expect(
      (await client.extract({ url: page.url, fields: { title: { selector: "h1" } }, render: true })).items,
    ).toEqual([{ title: "Owned" }])
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.example/prefix/read",
      "https://api.example/prefix/extract",
    ])
    expect(await requests[0]?.json()).toMatchObject({ sessionId: "owned", format: "text" })
  })

  test("screenshot and inspection helpers require browser output and preserve session routing", async () => {
    const { client, requests } = fixture(() =>
      Response.json({
        ...page,
        tier: 3,
        screenshot: "aGVsbG8=",
        consoleLogs: [],
        networkLogs: [],
        redirectChain: [page.url],
      }),
    )
    expect((await client.screenshot({ url: page.url, sessionId: "owned", screenshotFullPage: true })).screenshot).toBe(
      "aGVsbG8=",
    )
    expect((await client.inspect({ url: page.url })).redirectChain).toEqual([page.url])
    expect(await requests[0]?.json()).toMatchObject({
      sessionId: "owned",
      skipHttp: true,
      screenshot: true,
      screenshotFullPage: true,
    })
    expect(await requests[1]?.json()).toMatchObject({
      skipHttp: true,
      consoleLogs: true,
      networkLogs: true,
      redirectChain: true,
    })
    const missing = fixture(() => Response.json(page)).client
    await expect(missing.screenshot({ url: page.url })).rejects.toMatchObject({ kind: "protocol" })
  })

  test("rejects browser helpers with maxTier 1 before making a request", async () => {
    const { client, requests } = fixture(() => Response.json(page))
    const options = JSON.parse(JSON.stringify({ url: page.url, maxTier: 1 }))
    await expect(client.screenshot(options)).rejects.toThrow("maxTier")
    await expect(client.inspect(options)).rejects.toThrow("maxTier")
    expect(requests).toHaveLength(0)
  })

  test("rejects malformed image and diagnostic results", async () => {
    const { client } = fixture(() => Response.json({ ...page, screenshot: 123, networkLogs: "invalid" }))
    await expect(client.screenshot({ url: page.url })).rejects.toMatchObject({ kind: "protocol" })
    await expect(client.inspect({ url: page.url })).rejects.toMatchObject({ kind: "protocol" })
  })

  test("does not repeat read/extract through scrape when a server lacks these endpoints", async () => {
    const { client, requests } = fixture(() => Response.json({ error: "Not found" }, { status: 404 }))
    await expect(client.read({ url: page.url })).rejects.toMatchObject({ kind: "api", status: 404 })
    await expect(client.extract({ url: page.url, fields: { title: { selector: "h1" } } })).rejects.toMatchObject({
      kind: "api",
      status: 404,
    })
    expect(requests).toHaveLength(2)
  })

  test("forwards scrape options without confusing target status with API status", async () => {
    const { client, requests } = fixture(() => Response.json({ ...page, statusCode: 404 }))
    const options = { url: page.url, maxTimeout: 90000, headers: { "X-Target": "yes" }, screenshot: true }
    expect((await client.scrape(options)).statusCode).toBe(404)
    expect(requests[0]?.url).toBe("https://api.example/prefix/scrape")
    expect(await requests[0]?.json()).toEqual(options)
    expect(requests[0]?.headers.has("x-target")).toBe(false)
  })

  test("isolates API credentials and headers between clients", async () => {
    const seen: Headers[] = []
    const fetch: Fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers))
      return Response.json(page)
    }
    const secured = new Trawl({ baseURL: "https://api.example", apiKey: "owned-secret", fetch })
    const local = new Trawl({ fetch })
    await secured.scrape({ url: page.url })
    await local.scrape({ url: page.url })
    expect(seen[0]?.get("authorization")).toBe("Bearer owned-secret")
    expect(seen[1]?.has("authorization")).toBe(false)
  })

  test.each([
    { error: "Scrape deadline exceeded", timings: [{ tier: 3, status: "timeout", durationMs: 10 }] },
    { status: "error", message: "Browser pool saturated", solution: { status: 0 } },
  ])("preserves API error envelopes without retrying", async (body) => {
    const { client, requests } = fixture(() => Response.json(body, { status: 429, headers: { "retry-after": "2" } }))
    const error = await client.scrape({ url: page.url }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(TrawlError)
    expect(error).toMatchObject({ kind: "api", status: 429, retryAfter: "2", data: body })
    expect(requests).toHaveLength(1)
  })

  test("retains blocked evidence and reports GET failures only once", async () => {
    const evidence = { tier: 3, status: "blocked", url: page.url, html: "challenge wall" }
    const { client, requests } = fixture(() =>
      Response.json({ error: "Blocked", blockedEvidence: evidence }, { status: 503 }),
    )
    const error = await client.info().catch((error: unknown) => error)
    expect(error).toMatchObject({ kind: "api", status: 503, blockedEvidence: evidence })
    expect(requests).toHaveLength(1)
  })

  test.each(["<html>Gateway login</html>", "{not json}", "null", "{}"])(
    "rejects invalid successful API responses: %s",
    async (body) => {
      const { client } = fixture(() => new Response(body, { headers: { "content-type": "application/json" } }))
      await expect(client.scrape({ url: page.url })).rejects.toMatchObject({ kind: "protocol", status: 200 })
    },
  )

  test("rejects redirects instead of forwarding credentials or replaying a scrape", async () => {
    let redirects: RequestRedirect | undefined
    const client = new Trawl({
      baseURL: "https://api.example",
      apiKey: "owned-secret",
      fetch: async (_input, init) => {
        redirects = init?.redirect
        return new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } })
      },
    })
    await expect(client.scrape({ url: page.url })).rejects.toMatchObject({ kind: "api", status: 307 })
    expect(redirects).toBe("manual")
  })

  test("does not retain fetch request options or credentials in transport errors", async () => {
    const client = new Trawl({
      baseURL: "https://api.example",
      apiKey: "owned-secret",
      fetch: async () => {
        throw new Error("owned-secret: private transport details")
      },
    })
    const error = await client.info().catch((error: unknown) => error)
    expect(error).toMatchObject({ kind: "network" })
    expect(JSON.stringify(error)).not.toContain("owned-secret")
    expect(String(error)).not.toContain("owned-secret")
  })

  test("supports info, readiness and stats responses", async () => {
    const pool = { total: 1, available: 1, busy: 0, stalled: 0, live: 1, restarts: 0, avgRestarts: 0 }
    const { client } = fixture((request) => {
      if (request.url.endsWith("/health")) return Response.json({ status: "ok", uptime: 1, pool })
      if (request.url.endsWith("/stats")) return Response.json({ browsers: 1, ...pool, headful: null })
      return Response.json({ msg: "TRAWL is ready!", version: "1.9.3", uptime: 1 })
    })
    expect((await client.info()).version).toBe("1.9.3")
    expect((await client.health()).status).toBe("ok")
    expect((await client.stats()).browsers).toBe(1)
  })

  test("maps session handles and existing-session operations to the native API", async () => {
    const session = { id: "owned-session", createdAt: 1, expiresAt: 1000, busy: false, keepPage: true }
    const { client, requests } = fixture((request) => {
      if (request.url.endsWith("/scrape")) return Response.json(page)
      if (request.url.endsWith("/eval")) return Response.json({ value: "Owned title" })
      if (request.url.endsWith("/cookies")) return Response.json({ cookies: [] })
      if (request.method === "DELETE") return Response.json({ status: "ok" })
      if (request.method === "POST") return Response.json(session)
      return Response.json({ sessions: [session] })
    })
    const handle = await client.sessions.create({ keepPage: true })
    expect(handle.id).toBe(session.id)
    expect(handle.details).toEqual(session)
    expect(await handle.scrape({ url: page.url })).toEqual(page)
    expect(await handle.eval("document.title")).toBe("Owned title")
    expect(await handle.cookies()).toEqual([])
    await handle.close()
    expect(await client.sessions.list()).toEqual([session])
    expect(await client.sessions.eval(session.id, "document.title", { maxTimeout: 1000 })).toBe("Owned title")
    expect(await requests[2]?.json()).toEqual({ expression: "document.title" })
    expect(requests[4]?.method).toBe("DELETE")
    expect(requests[1]?.url).toBe("https://api.example/prefix/sessions/owned-session/scrape")
  })

  test("rejects conflicting session IDs and unsafe path segments before sending", async () => {
    const { client, requests } = fixture(() => Response.json(page))
    await expect(client.sessions.scrape("one", { url: page.url, sessionId: "two" })).rejects.toThrow("sessionId")
    await expect(client.sessions.cookies("../health")).rejects.toThrow("session")
    expect(requests).toHaveLength(0)
  })

  test("combines caller cancellation with a timeout that covers response consumption", async () => {
    let received = 0
    const origin = Bun.serve({
      port: 0,
      fetch() {
        if (++received > 2) return Response.json(page)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"url":'))
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      const controller = new AbortController()
      const client = new Trawl({ baseURL: origin.url.href })
      await expect(
        client.scrape({ url: page.url }, { timeoutMs: 80, signal: controller.signal }),
      ).rejects.toMatchObject({ kind: "timeout" })
      controller.abort()
      await expect(client.scrape({ url: page.url }, { signal: controller.signal })).rejects.toMatchObject({
        kind: "aborted",
      })
      const duringRequest = new AbortController()
      const abort = setTimeout(() => duringRequest.abort(), 30)
      try {
        await expect(
          client.scrape({ url: page.url }, { timeoutMs: 1000, signal: duringRequest.signal }),
        ).rejects.toMatchObject({ kind: "aborted" })
      } finally {
        clearTimeout(abort)
      }
      expect(await client.scrape({ url: page.url })).toEqual(page)
      expect(received).toBe(3)
    } finally {
      origin.stop(true)
    }
  })

  test("validates connection deadlines and allows a request override", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])
      expect(() => new Trawl({ timeoutMs })).toThrow("timeoutMs")
    const { client, requests } = fixture(() => Response.json(page))
    await expect(client.scrape({ url: page.url }, { timeoutMs: 0 })).rejects.toThrow("timeoutMs")
    expect(requests).toHaveLength(0)
    expect(await client.scrape({ url: page.url }, { timeoutMs: 1000 })).toEqual(page)
  })

  test.each(["ftp://host", "https://user:password@host", "https://host/?key=secret", "//other.example"])(
    "rejects an unsafe base URL: %s",
    (baseURL) => {
      expect(() => new Trawl({ baseURL })).toThrow()
    },
  )
})
