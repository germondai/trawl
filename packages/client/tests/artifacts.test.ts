import { expect, test } from "bun:test"
import { Trawl, TrawlError } from "../src/index"

test("request-only capture metadata and JSON input use the authenticated artifact API", async () => {
  const api = new Trawl({
    apiKey: "owned-token",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      expect(request.headers.get("authorization")).toBe("Bearer owned-token")
      if (new URL(request.url).pathname.endsWith("/request"))
        return Response.json({
          version: 1,
          source: "native",
          operation: "scrape",
          parameters: { url: "https://owned.fixture" },
        })
      return Response.json({
        requestId: "owned-id",
        requestAt: "2026-11-16T10:00:00.000Z",
        mode: "none",
        artifacts: [{ kind: "request", state: "unavailable", reason: "capture-busy" }],
      })
    },
  })
  expect((await api.requests.captures("owned-id")).artifacts[0]?.kind).toBe("request")
  expect(JSON.parse(new TextDecoder().decode(await api.requests.artifact("owned-id", "request")))).toMatchObject({
    version: 1,
    parameters: { url: "https://owned.fixture" },
  })
})

test("artifact metadata and bytes use separate authenticated resources with validated identifiers", async () => {
  const calls: Request[] = []
  const api = new Trawl({
    baseURL: "https://owned.fixture",
    apiKey: "owned-token",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (new URL(request.url).pathname.endsWith("/html")) return new Response("<p>saved</p>")
      return Response.json({
        requestId: "owned-id",
        requestAt: "2026-11-16T10:00:00.000Z",
        mode: "html",
        artifacts: [
          {
            kind: "html",
            state: "ready",
            bytes: 12,
            storedBytes: 12,
            sha256: "a".repeat(64),
            encoding: "identity",
            contentType: "text/html",
            capturedAt: "2026-11-16T10:00:00.000Z",
          },
        ],
      })
    },
  })
  expect((await api.requests.captures("owned-id")).artifacts[0]?.state).toBe("ready")
  expect(new TextDecoder().decode(await api.requests.artifact("owned-id", "html"))).toBe("<p>saved</p>")
  expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
    "/requests/owned-id/captures",
    "/requests/owned-id/captures/html",
  ])
  expect(calls.every((request) => request.headers.get("authorization") === "Bearer owned-token")).toBe(true)
  expect(() => api.requests.artifact("../bad", "html")).toThrow()
  expect(() => api.requests.artifact("owned-id", "../bad" as "html")).toThrow()
})

test("malformed and mismatched capture manifests are rejected before viewing", async () => {
  for (const patch of [
    { requestId: "different-id" },
    { artifacts: [{ kind: "html", state: "ready", bytes: 999999999 }] },
    { artifacts: [{ kind: { toString: {} }, state: "ready" }] },
    { artifacts: [{ kind: "html", state: "failed", capturedAt: { toString: {} } }] },
    { requestAt: "invalid-date" },
  ]) {
    const api = new Trawl({
      fetch: async () =>
        Response.json({
          requestId: "owned-id",
          requestAt: "2026-11-16T10:00:00.000Z",
          mode: "html",
          artifacts: [],
          ...patch,
        }),
    })
    await expect(api.requests.captures("owned-id")).rejects.toMatchObject({ kind: "protocol" })
  }
})

test("streamed artifact bytes stop at the client limit and cancel the source", async () => {
  let cancelled = false
  let chunks = 0
  const api = new Trawl({
    fetch: async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              chunks++
              controller.enqueue(new Uint8Array(1024 * 1024))
            },
            cancel() {
              cancelled = true
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  })
  await expect(api.requests.artifact("owned-id", "screenshot")).rejects.toMatchObject({ kind: "protocol" })
  expect(chunks).toBe(9)
  expect(cancelled).toBe(true)
})

test("artifact deadlines bound a provider that ignores abort and never resolves cancellation", async () => {
  let cancelled = false
  const api = new Trawl({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          },
          cancel() {
            cancelled = true
            return new Promise(() => {})
          },
        }),
      ),
  })
  const started = performance.now()
  await expect(api.requests.artifact("owned-id", "html", { timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" })
  expect(performance.now() - started).toBeLessThan(500)
  expect(cancelled).toBe(true)
})

test("an artifact API error is not retried", async () => {
  let calls = 0
  const api = new Trawl({
    fetch: async () => {
      calls++
      return Response.json({ error: "Expired" }, { status: 404 })
    },
  })
  try {
    await api.requests.artifact("owned-id", "html")
    throw new Error("Expected failure")
  } catch (error) {
    expect(error).toBeInstanceOf(TrawlError)
    expect(error).toMatchObject({ kind: "api", status: 404 })
  }
  expect(calls).toBe(1)
})

test("eager empty chunks cannot starve the artifact deadline", async () => {
  let cancelled = false
  const api = new Trawl({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(0))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  const started = performance.now()
  await expect(api.requests.artifact("owned-id", "html", { timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" })
  expect(performance.now() - started).toBeLessThan(500)
  expect(cancelled).toBe(true)
})
