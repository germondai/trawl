import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestratorDeps } from "@trawl/tiers"
import { Elysia } from "elysia"
import { CaptureStore, defaultCapturePolicy } from "./captureStore"
import { MetricsStore } from "./metrics"
import { observabilityRoute } from "./routes/observability"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

const secret = "owned-capture-fixture-token-at-least-32-characters"
const read = (path: string, authorized = true, signal?: AbortSignal) =>
  new Request(`http://localhost${path}`, { headers: authorized ? { authorization: `Bearer ${secret}` } : {}, signal })

test("captured resources require authentication and retained history, bound transfers and survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-capture-api-"))
  let captures = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "html" })
  const metrics = new MetricsStore(true, ":memory:", true)
  const html = `<p>${"owned fixture ".repeat(20000)}</p>`
  const responses: Response[] = []
  try {
    await captures.ready
    metrics.record({
      requestId: "saved",
      source: "native",
      url: "https://owned.fixture",
      durationMs: 1,
      statusCode: 200,
    })
    const entry = metrics.request("saved")
    if (!entry) throw new Error("Missing retained entry")
    captures.capture({ requestId: entry.id, requestAt: entry.at, html })
    captures.capture({ requestId: "not-retained", requestAt: entry.at, html: "private orphan" })
    await captures.flush()
    await captures.close()
    captures = new CaptureStore(directory, defaultCapturePolicy)
    await captures.ready
    const app = observabilityRoute({ enabled: true, secret, store: metrics, captureStore: captures })
    for (const path of ["/requests/saved/captures", "/requests/saved/captures/html"])
      expect((await app.handle(read(path, false))).status).toBe(401)
    expect((await (await app.handle(read("/capabilities", false))).json()).captures).toBe(true)
    expect((await app.handle(read("/requests/not-retained/captures/html"))).status).toBe(404)
    expect((await app.handle(read("/requests/saved/captures/other"))).status).toBe(400)
    expect((await app.handle(read("/requests/saved/captures/screenshot"))).status).toBe(404)
    const manifest = await (await app.handle(read("/requests/saved/captures"))).json()
    expect(manifest).toMatchObject({
      requestId: "saved",
      requestAt: entry.at,
      mode: "html",
      artifacts: [{ kind: "html", state: "ready" }],
    })
    const response = await app.handle(read("/requests/saved/captures/html"))
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(response.headers.get("content-disposition")).toContain("attachment")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
    expect(await response.text()).toBe(html)
    for (let index = 0; index < 4; index++) responses.push(await app.handle(read("/requests/saved/captures/html")))
    expect(responses.every((value) => value.status === 200)).toBe(true)
    expect((await app.handle(read("/requests/saved/captures/html"))).status).toBe(429)
    await responses[0]?.body?.cancel()
    const abort = new AbortController()
    const replacement = await app.handle(read("/requests/saved/captures/html", true, abort.signal))
    expect(replacement.status).toBe(200)
    responses.push(replacement)
    abort.abort()
    const afterAbort = await app.handle(read("/requests/saved/captures/html"))
    responses.push(afterAbort)
    expect(afterAbort.status).toBe(200)
    expect(captures.manifest("saved", "different-entry").artifacts).toEqual([])
  } finally {
    await Promise.allSettled(responses.map((value) => value.body?.cancel()))
    await captures.close()
    metrics.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("native GET, JSON POST and Prowlarr retain existing content without extra target requests or browser launches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-capture-http-"))
  const captures = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "both" })
  const metrics = new MetricsStore(true, ":memory:", true)
  let calls = 0
  let launches = 0
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++
      if (request.method === "POST") return Response.json({ received: await request.json() })
      return new Response(
        `<html><title>Owned capture fixture</title><p>${"Readable fixture. ".repeat(30)}</p></html>`,
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => {
      launches++
      throw new Error("Unexpected browser")
    },
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  await captures.ready
  const app = new Elysia()
    .use(
      scrapeRoute(
        () => deps,
        () => true,
        metrics,
        captures,
      ),
    )
    .use(
      v1Route({
        orchestratorDeps: () => deps,
        poolReady: () => true,
        metricsStore: metrics,
        captureStore: captures,
        cookieFallback: false,
      }),
    )
    .use(observabilityRoute({ enabled: true, secret, store: metrics, captureStore: captures }))
    .listen({ hostname: "127.0.0.1", port: 0 })
  if (!app.server) throw new Error("Fixture failed to start")
  const base = `http://127.0.0.1:${app.server.port}`
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  try {
    for (const [path, body] of [
      ["/scrape", { url: target.url.href, maxTier: 1, detectWaf: false }],
      [
        "/scrape",
        {
          url: target.url.href,
          maxTier: 1,
          method: "POST",
          body: '{"hello":"world"}',
          headers: { "content-type": "application/json" },
          detectWaf: false,
        },
      ],
      ["/v1", { cmd: "request.get", url: target.url.href, maxTimeout: 10000 }],
    ] as const) {
      const response = await post(path, body)
      expect(response.status).toBe(200)
      const payload = await response.json()
      const id = response.headers.get("x-trawl-request-id")
      if (!id) throw new Error("Missing request ID")
      await captures.flush()
      const metadata = await (await app.handle(read(`/requests/${id}/captures`))).json()
      expect(metadata.artifacts.map((value: { state: string }) => value.state)).toEqual(["ready", "unavailable"])
      const saved = await (await app.handle(read(`/requests/${id}/captures/html`))).text()
      expect(saved).toBe(path === "/v1" ? payload.solution.response : payload.html)
    }
    expect(calls).toBe(3)
    expect(launches).toBe(0)
    const failure = spyOn(captures, "capture").mockImplementation(() => {
      throw new Error("Owned storage failure")
    })
    try {
      expect((await post("/scrape", { url: target.url.href, maxTier: 1, detectWaf: false })).status).toBe(200)
    } finally {
      failure.mockRestore()
    }
    expect(calls).toBe(4)
    expect(launches).toBe(0)
  } finally {
    await app.stop(true)
    target.stop(true)
    await captures.close()
    metrics.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
