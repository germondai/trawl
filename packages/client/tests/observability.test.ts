import { expect, test } from "bun:test"
import { Trawl } from "../src/index"

const cursor = "10000000-0000-4000-8000-000000000000:1"
const entry = { at: "2026-11-16T12:00:00Z", scope: "api", level: "info" as const, message: "server.start" }
const frame = `id: ${cursor}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`
const encode = (value: string) => new TextEncoder().encode(value)

test("activity pages validate pagination before transport and retain filtered totals", async () => {
  const client = new Trawl({
    fetch: async (url) => {
      const query = new URL(String(url)).searchParams
      expect(query.get("page")).toBe("2")
      expect(query.get("limit")).toBe("20")
      expect(query.get("sessionId")).toBe("session")
      expect(query.get("requestId")).toBe("request-a")
      return Response.json({ entries: [], page: 2, total: 40 })
    },
  })
  expect(await client.sessions.activityPage("session", { page: 2, requestId: "request-a" })).toEqual({
    entries: [],
    page: 2,
    total: 40,
  })
  expect(() => client.sessions.activityPage(undefined, { page: 0 })).toThrow()
  expect(() => client.sessions.activityPage(undefined, { limit: 101 })).toThrow()
  const invalid = new Trawl({ fetch: async () => Response.json({ entries: [], page: 0, total: 0 }) })
  await expect(invalid.sessions.activityPage()).rejects.toThrow()
})

test("saved Markdown validates the resource ID and bounded response", async () => {
  const client = new Trawl({
    fetch: async (url) => {
      expect(String(url)).toContain("/requests/saved/markdown")
      return Response.json({ text: "# Saved", truncated: false })
    },
  })
  expect(await client.requests.markdown("saved")).toEqual({ text: "# Saved", truncated: false })
  expect(() => client.requests.markdown("../private")).toThrow()
  const invalid = new Trawl({ fetch: async () => Response.json({ text: "x".repeat(100001), truncated: false }) })
  await expect(invalid.requests.markdown("saved")).rejects.toThrow()
})

test("failed native requests retain the server's validated correlation ID", async () => {
  const client = new Trawl({
    fetch: async () =>
      Response.json(
        { error: "Owned fixture failure" },
        {
          status: 500,
          headers: { "X-Trawl-Request-ID": "owned-failed-request" },
        },
      ),
  })
  await expect(client.scrape({ url: "https://owned.test" })).rejects.toMatchObject({
    kind: "api",
    status: 500,
    requestId: "owned-failed-request",
  })
})

test("large transport chunks containing many small events retain every event", async () => {
  const client = new Trawl({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encode(frame.repeat(3000)))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  let received = 0
  for await (const value of client.logs.events()) {
    expect(value.type).toBe("entry")
    if (++received === 3000) break
  }
  expect(received).toBe(3000)
})

test.each([null, {}, { products: 1 }, { engine: "wafmeow", version: "3.1.0", state: "complete", products: [null] }])(
  "rejects malformed optional WAF details before rendering",
  async (waf) => {
    const client = new Trawl({
      fetch: async () =>
        Response.json({
          id: "fixture",
          at: "2026-11-16T12:00:00Z",
          domain: "owned.test",
          source: "native",
          method: "GET",
          durationMs: 1,
          success: true,
          tier: 1,
          tierStatus: "success",
          statusCode: 200,
          category: null,
          severity: null,
          waf,
        }),
    })
    await expect(client.requests.get("fixture")).rejects.toMatchObject({ kind: "protocol" })
  },
)

test("settings, capabilities and histories use authenticated native endpoints", async () => {
  const inputs: Request[] = []
  const client = new Trawl({
    baseURL: "https://fixture.test/prefix",
    apiKey: "fixture-key",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      inputs.push(request)
      if (request.url.endsWith("/capabilities"))
        return Response.json({
          version: 1,
          authentication: "bearer",
          settings: true,
          requests: true,
          requestEvents: true,
          logs: true,
          logEvents: true,
          captures: false,
          browserInspection: false,
        })
      if (request.url.endsWith("/settings")) return Response.json({ readOnly: true, settings: [] })
      if (request.url.includes("/logs"))
        return Response.json({ entries: [], cursor, coverage: "structured-application-logs-since-start" })
      return Response.json({ entries: [], nextCursor: null, cursor, active: [], activeTruncated: false })
    },
  })
  expect((await client.capabilities()).settings).toBe(true)
  expect((await client.settings()).readOnly).toBe(true)
  await client.requests.list({ limit: 2, before: "request-id" })
  await client.logs.list(10)
  expect(inputs.map(({ url }) => url)).toEqual([
    "https://fixture.test/prefix/capabilities",
    "https://fixture.test/prefix/settings",
    "https://fixture.test/prefix/requests?limit=2&before=request-id",
    "https://fixture.test/prefix/logs?limit=10",
  ])
  expect(inputs.every(({ headers }) => headers.get("authorization") === "Bearer fixture-key")).toBe(true)
  expect(() => client.requests.get("../settings")).toThrow("ID")
  expect(() => client.requests.list({ limit: 101 })).toThrow("limit")
  await client.requests.list({
    page: 2,
    search: "owned.test",
    source: "proxy",
    result: "success",
    sort: "slowest",
    tier: 3,
  })
  expect(inputs.at(-1)?.url).toBe(
    "https://fixture.test/prefix/requests?page=2&search=owned.test&source=proxy&result=success&sort=slowest&tier=3",
  )
  expect(() => client.requests.list({ page: 0 })).toThrow("page")
  expect(() => client.requests.list({ search: "x".repeat(201) })).toThrow("search")
  expect(() => client.requests.list({ tier: 6 })).toThrow("tier")
  expect(() => client.requests.list({ before: "id", page: 1 })).toThrow("before")
})

test("streams over real HTTP with header auth, replay cursors and cleanup on early iterator return", async () => {
  let cancelled = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/logs/events")
      expect(new URL(request.url).search).toBe("")
      expect(request.headers.get("authorization")).toBe("Bearer fixture-key")
      expect(request.headers.get("last-event-id")).toBe(cursor)
      return new Response(
        new ReadableStream({
          start(controller) {
            const bytes = encode(`: heartbeat\r\n\r\n${frame.replaceAll("\n", "\r\n")}`)
            for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const client = new Trawl({ baseURL: server.url.href, apiKey: "fixture-key" })
    for await (const value of client.logs.events({ cursor })) {
      expect(value).toEqual({ type: "entry", id: cursor, data: entry })
      break
    }
    for (let index = 0; index < 20 && !cancelled; index++) await Bun.sleep(5)
    expect(cancelled).toBe(true)
  } finally {
    server.stop(true)
  }
})

test("idle deadlines cancel a stalled stream without using a whole-response timeout", async () => {
  let cancelled = false
  const client = new Trawl({
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const events = client.logs.events({ idleTimeoutMs: 10 })
  await expect(events.next()).rejects.toMatchObject({ kind: "timeout" })
  expect(cancelled).toBe(true)
})

test("external cancellation tears down a pending stream read", async () => {
  const abort = new AbortController()
  const client = new Trawl({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encode(frame))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const events = client.logs.events({ signal: abort.signal })
  await events.next()
  const pending = events.next()
  abort.abort()
  await expect(pending).rejects.toMatchObject({ kind: "aborted" })
})

test.each([
  `id: ${cursor}\nevent: entry\ndata: {"wrong":true}\n\n`,
  `id: bad\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`,
  `id: ${cursor}\nevent: entry\ndata: ${"x".repeat(20000)}`,
])("rejects malformed or oversized stream messages", async (text) => {
  const client = new Trawl({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encode(text))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  await expect(client.logs.events().next()).rejects.toMatchObject({ kind: "protocol" })
})

test("session activity sends request ownership as a validated query filter", async () => {
  const paths: string[] = []
  const client = new Trawl({
    fetch: async (input) => {
      paths.push(String(input))
      return Response.json({ entries: [] })
    },
  })
  expect(await client.sessions.activity("shared", { requestId: "request-a" })).toEqual([])
  expect(new URL(paths[0] ?? "about:blank").searchParams.get("requestId")).toBe("request-a")
  await expect(client.sessions.activity("shared", { requestId: "../other" })).rejects.toThrow("Invalid request ID")
  expect(paths).toHaveLength(1)
})
