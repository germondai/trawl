import { describe, expect, test } from "bun:test"
import type { ApplicationLog } from "@trawl/types"
import { Elysia } from "elysia"
import { EventJournal } from "../eventJournal"
import { MetricsStore } from "../metrics"
import { observabilityRoute } from "./observability"

const secret = "observability-test-token-at-least-32-characters"
const request = (path: string, authorized = true) =>
  new Request(`http://localhost${path}`, {
    headers: authorized ? { authorization: `Bearer ${secret}` } : {},
  })

describe("instance observability resources", () => {
  test("requires explicit enablement and a strong token independent of anonymous metrics", async () => {
    const store = new MetricsStore()
    for (const options of [
      { enabled: false, secret },
      { enabled: true, secret: "" },
      { enabled: true, secret: "short" },
    ]) {
      const app = observabilityRoute({ ...options, store })
      expect((await app.handle(request("/capabilities", false))).status).toBe(200)
      expect((await (await app.handle(request("/capabilities"))).json()).requests).toBe(false)
      for (const path of ["/requests", "/requests/events", "/logs", "/logs/events"])
        expect((await app.handle(request(path))).status).toBe(404)
    }
    store.close()
  })

  test("protects all data resources without adding authentication to scraping routes", async () => {
    const store = new MetricsStore(true, ":memory:", true)
    const app = new Elysia()
      .use(observabilityRoute({ enabled: true, secret, store }))
      .post("/scrape", () => ({ ok: true }))
    for (const path of ["/requests", "/requests/any", "/requests/events", "/logs", "/logs/events"]) {
      const response = await app.handle(request(path, false))
      expect(response.status).toBe(401)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    expect((await app.handle(new Request("http://localhost/scrape", { method: "POST" }))).status).toBe(200)
    store.close()
  })

  test("paginates history, reads stable details and rejects invalid or pruned cursors", async () => {
    const store = new MetricsStore(true, ":memory:", true)
    const app = observabilityRoute({ enabled: true, secret, store })
    for (const id of ["first", "second", "third"])
      store.record({
        requestId: id,
        method: "GET",
        source: "native",
        url: "https://user:password@example.test/private?token=secret",
        durationMs: 2,
        statusCode: 200,
      })
    const first = await (await app.handle(request("/requests?limit=2"))).json()
    expect(first.entries.map((entry: { id: string }) => entry.id)).toEqual(["third", "second"])
    expect(first.nextCursor).toBe("second")
    store.record({ requestId: "fourth", source: "mcp", url: "https://new.test", durationMs: 1, statusCode: 200 })
    const second = await (await app.handle(request(`/requests?limit=2&before=${first.nextCursor}`))).json()
    expect(second.entries.map((entry: { id: string }) => entry.id)).toEqual(["first"])
    expect(second.nextCursor).toBeNull()
    const detail = await (await app.handle(request("/requests/third"))).json()
    expect(detail).toMatchObject({ id: "third", domain: "example.test", method: "GET" })
    expect(JSON.stringify(detail)).not.toMatch(/password|private|token/)
    expect((await app.handle(request("/requests?before=missing"))).status).toBe(409)
    for (const query of ["limit=0", "limit=101", "limit=NaN", "before=bad:cursor"])
      expect((await app.handle(request(`/requests?${query}`))).status).toBe(400)
    expect((await app.handle(request("/requests/missing"))).status).toBe(404)
    store.close()
  })

  test("keeps request and application-log streams independent with separate replay cursors", async () => {
    const store = new MetricsStore(true, ":memory:", true)
    const logs = new EventJournal<ApplicationLog>()
    const app = observabilityRoute({ enabled: true, secret, store, logs })
    const history = await (await app.handle(request("/requests"))).json()
    const logSnapshot = await (await app.handle(request("/logs"))).json()
    expect(history.cursor).not.toBe(logSnapshot.cursor)
    const streamed = async (path: string, cursor: string) => {
      const input = request(path)
      input.headers.set("Last-Event-ID", cursor)
      const response = await app.handle(input)
      expect(response.status).toBe(200)
      const reader = response.body?.getReader()
      if (!reader) throw new Error("Missing stream response")
      await reader.read()
      return reader
    }
    const requestReader = await streamed("/requests/events", history.cursor)
    const logReader = await streamed("/logs/events", logSnapshot.cursor)
    store.startRequest("running", "flaresolverr", "https://example.test", "POST")
    expect(new TextDecoder().decode((await requestReader.read()).value)).toContain('"type":"started"')
    const active = await (await app.handle(request("/requests"))).json()
    expect(active.active).toMatchObject([{ id: "running", source: "flaresolverr", method: "POST" }])
    logs.publish({ at: new Date().toISOString(), level: "info", scope: "api", message: "ready" })
    expect(new TextDecoder().decode((await logReader.read()).value)).toContain('"message":"ready"')
    store.record({
      requestId: "running",
      source: "flaresolverr",
      url: "https://example.test",
      durationMs: 4,
      statusCode: 200,
    })
    expect(new TextDecoder().decode((await requestReader.read()).value)).toContain('"type":"completed"')
    expect(store.history().active).toEqual([])
    await requestReader.cancel()
    await logReader.cancel()
    expect(store.events.subscribers).toBe(0)
    expect(logs.subscribers).toBe(0)
    store.close()
    logs.close()
  })
})
