import { expect, test } from "bun:test"
import { scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { routeContinueOverrides } from "../src/utils/sanitize"
import { prepareTargetRequest } from "../src/utils/targetRequest"
import { tlsFetch } from "../src/utils/tlsTransport"

test("explicit target credentials are validated and kept separate from raw reserved headers", () => {
  const base = { url: "https://owned.fixture/", maxTier: 1 as const }
  expect(
    prepareTargetRequest({ ...base, targetAuth: { type: "basic", username: "user", password: "p:č" } }).credential,
  ).toEqual({ name: "Authorization", value: `Basic ${Buffer.from("user:p:č").toString("base64")}` })
  expect(
    prepareTargetRequest({ ...base, targetAuth: { type: "bearer", token: "owned-token" } }).credential?.value,
  ).toBe("Bearer owned-token")
  expect(
    prepareTargetRequest({ ...base, targetAuth: { type: "api-key", name: "key", value: "a+b", in: "query" } }).url,
  ).toBe("https://owned.fixture/?key=a%2Bb")
  for (const targetAuth of [
    { type: "bearer", token: "a\r\nb" },
    { type: "basic", username: "user:name", password: "p" },
    { type: "api-key", name: "Host", value: "foreign", in: "header" },
  ])
    expect(() => prepareTargetRequest({ ...base, targetAuth } as never)).toThrow("authentication")
  expect(() => prepareTargetRequest({ ...base, maxTier: 4, targetAuth: { type: "bearer", token: "key" } })).toThrow(
    "HTTP-only",
  )
})

test("binary decoding is strict, bounded and passed byte-for-byte to browser POST overrides", () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 1])
  const request = {
    url: "https://owned.fixture",
    method: "POST" as const,
    body: bytes.toString("base64"),
    bodyEncoding: "base64" as const,
  }
  const decoded = prepareTargetRequest(request).body
  expect(decoded).toEqual(bytes)
  expect(prepareTargetRequest({ ...request, method: "PUT", maxTier: 1 }).body).toEqual(bytes)
  expect(() => prepareTargetRequest({ ...request, method: "PUT", maxTier: 4 })).toThrow("HTTP-only")
  const overrides = routeContinueOverrides(
    { request: () => ({ headers: () => ({}), method: () => "GET" }), continue: async () => {} },
    undefined,
    "POST",
    decoded,
  )
  expect(overrides.postData).toEqual(bytes)
  for (const body of ["not base64!", "Zh==", "A".repeat(1398108)])
    expect(() => prepareTargetRequest({ ...request, body })).toThrow()
  expect(() => prepareTargetRequest({ ...request, method: "GET" })).toThrow("body-capable")
})

test("HTTP auth and binary bodies preserve redirects without forwarding credentials to a different origin", async () => {
  const seen: { path: string; auth: string | null; key: string | null; body: string }[] = []
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      seen.push({
        path: "foreign",
        auth: request.headers.get("authorization"),
        key: request.headers.get("x-key"),
        body: Buffer.from(await request.arrayBuffer()).toString("base64"),
      })
      return new Response("<html><body>Owned destination</body></html>", { headers: { "Content-Type": "text/html" } })
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname
      seen.push({
        path,
        auth: request.headers.get("authorization"),
        key: request.headers.get("x-key"),
        body: Buffer.from(await request.arrayBuffer()).toString("base64"),
      })
      if (path === "/same") return Response.redirect(`${server.url}foreign`, 307)
      if (path === "/foreign") return Response.redirect(other.url, 307)
      return new Response("<html><body>Owned destination</body></html>", { headers: { "Content-Type": "text/html" } })
    },
  })
  try {
    const bytes = Buffer.from([0, 255, 128, 1])
    const deps = {
      acquireBrowser: async () => {
        throw Error("Must not acquire browser")
      },
      releaseBrowser: () => {},
      loadSession: async () => {
        throw Error("Auth must not reuse domain sessions")
      },
      saveSession: async () => {
        throw Error("Auth must not save domain sessions")
      },
      invalidateSession: async () => {},
    }
    await scrape(
      {
        url: `${server.url}same`,
        maxTier: 1,
        method: "POST",
        bodyEncoding: "base64",
        body: bytes.toString("base64"),
        headers: { "Content-Type": "application/octet-stream" },
        targetAuth: { type: "bearer", token: "owned" },
      },
      deps,
    )
    expect(seen.map((r) => r.auth)).toEqual(["Bearer owned", "Bearer owned", null])
    expect(seen.map((r) => r.body)).toEqual(Array(3).fill(bytes.toString("base64")))
    seen.length = 0
    await scrape(
      {
        url: `${server.url}same`,
        maxTier: 1,
        targetAuth: { type: "api-key", name: "X-Key", value: "owned", in: "header" },
      },
      deps,
    )
    expect(seen.map((r) => r.key)).toEqual(["owned", "owned", null])
    seen.length = 0
    await runTier1(`${server.url}echo`, undefined, "POST", bytes)
    expect(seen[0]?.body).toBe(bytes.toString("base64"))
    seen.length = 0
    await tlsFetch(`${server.url}echo`, { method: "POST", body: bytes })
    expect(seen[0]?.body).toBe(bytes.toString("base64"))
  } finally {
    server.stop(true)
    other.stop(true)
  }
})
