import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CaptureStore, defaultCapturePolicy } from "./captureStore"
import { MetricsStore } from "./metrics"
import { observabilityRoute } from "./routes/observability"
import { recordSessionEval } from "./sessionActivity"

const secret = "session-activity-test-token-at-least-32-characters"
const request = (path: string, authorized = true) =>
  new Request(`http://localhost${path}`, { headers: authorized ? { authorization: `Bearer ${secret}` } : {} })

test("activity pagination counts filtered retained rows and keeps legacy lists compatible", async () => {
  const store = new MetricsStore(true, ":memory:", true)
  try {
    for (let i = 0; i < 47; i++)
      store.recordActivity({
        id: `page-${i}`,
        at: new Date(Date.now() - i * 1000).toISOString(),
        sessionId: i < 45 ? "session" : "other",
        requestId: i < 30 ? "request-a" : "request-b",
        operation: "eval",
        durationMs: 1,
        success: true,
        scriptBytes: 1,
        scriptHash: "a".repeat(64),
      })
    const app = observabilityRoute({ enabled: true, secret, store })
    const get = async (query: string) => (await app.handle(request(`/session-activity?${query}`))).json()
    const first = await get("sessionId=session&limit=20&page=1")
    const second = await get("sessionId=session&limit=20&page=2")
    const last = await get("sessionId=session&limit=20&page=5000")
    expect(first).toMatchObject({ total: 45, page: 1 })
    expect(second.entries).toHaveLength(20)
    expect(new Set([...first.entries, ...second.entries].map((row) => row.id)).size).toBe(40)
    expect(last).toMatchObject({ total: 45, page: 3 })
    expect(last.entries).toHaveLength(5)
    expect(await get("requestId=request-a&limit=20&page=2")).toMatchObject({ total: 30, page: 2 })
    expect(await get("sessionId=missing&limit=20&page=2")).toEqual({ entries: [], total: 0, page: 1 })
    expect((await get("sessionId=session")).entries).toHaveLength(45)
    expect((await app.handle(request("/session-activity?page=2", false))).status).toBe(401)
    for (const page of ["0", "5001", "1.5", "NaN"])
      expect((await app.handle(request(`/session-activity?page=${page}`))).status).toBe(400)
  } finally {
    store.close()
  }
})

test("eval metadata excludes source, results and raw errors and does not change scraping counters", async () => {
  const store = new MetricsStore(true, ":memory:", true)
  try {
    const result = { private: "result-secret" }
    expect(
      await recordSessionEval(
        store,
        undefined,
        "session-one",
        "globalThis.secret = 'source-secret'",
        async () => result,
      ),
    ).toBe(result)
    const error = new Error("network failed https://name:password@private.test/secret-path?token=secret")
    await expect(
      recordSessionEval(store, undefined, "session-one", "'second-source'", async () => {
        throw error
      }),
    ).rejects.toBe(error)
    const records = store.activities("session-one")
    expect(records).toHaveLength(2)
    expect(records.find((row) => !row.success)?.cause).toBe("network")
    expect(records.every((row) => row.durationMs >= 0 && row.scriptHash.length === 64)).toBe(true)
    const json = JSON.stringify(records)
    for (const value of ["source-secret", "result-secret", "password", "secret-path", "second-source"])
      expect(json).not.toContain(value)
    expect(store.snapshot(60).requests).toBe(0)
    expect(JSON.stringify(store.snapshot(60))).not.toContain("session-one")
    store.close()
    expect(await recordSessionEval(store, undefined, "session-one", "1", async () => 42)).toBe(42)
  } finally {
    try {
      store.close()
    } catch {}
  }
})

test("activity and script captures require the observability token and a retained activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trawl-activity-"))
  const store = new MetricsStore(true, ":memory:", true)
  const capture = new CaptureStore(directory, { ...defaultCapturePolicy, request: true })
  await capture.ready
  try {
    await recordSessionEval(store, capture, "retained-session", "document.title", async () => "private title")
    await capture.flush()
    const entry = store.activities()[0]
    if (!entry) throw Error("Activity was not recorded")
    const app = observabilityRoute({ enabled: true, secret, store, captureStore: capture, mcpEnabled: true })
    for (const path of [
      "/session-activity",
      `/session-activity/${entry.id}/captures`,
      `/session-activity/${entry.id}/captures/request`,
    ]) {
      expect((await app.handle(request(path, false))).status).toBe(401)
      const response = await app.handle(request(path))
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    const body = await (await app.handle(request(`/session-activity/${entry.id}/captures/request`))).json()
    expect(body.parameters.expression).toBe("document.title")
    expect(JSON.stringify(body)).not.toContain("private title")
    expect((await app.handle(request("/session-activity?sessionId=retained-session&limit=1"))).status).toBe(200)
    expect((await app.handle(request("/session-activity?sessionId=../private"))).status).toBe(400)
    expect((await app.handle(request("/session-activity?limit=101"))).status).toBe(400)
    expect((await app.handle(request("/other-collection/not-retained/captures"))).status).toBe(404)
    expect((await app.handle(request(`/requests/${entry.id}/captures`))).status).toBe(404)
    const expired = { ...entry, id: "expired-activity", at: "2000-01-01T00:00:00.000Z" }
    store.recordActivity(expired)
    expect(store.activity(expired.id)).toBeUndefined()
    expect((await app.handle(request(`/session-activity/${expired.id}/captures/request`))).status).toBe(404)
  } finally {
    await capture.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("request activity filters exact page ownership and leaves legacy activity unassigned", async () => {
  const store = new MetricsStore(true, ":memory:", true)
  try {
    await recordSessionEval(
      store,
      undefined,
      "shared",
      "1",
      async () => 1,
      () => "request-a",
    )
    await recordSessionEval(
      store,
      undefined,
      "shared",
      "2",
      async () => 2,
      () => "request-b",
    )
    await recordSessionEval(store, undefined, "shared", "legacy", async () => 3)
    const app = observabilityRoute({ enabled: true, secret, store })
    expect(await (await app.handle(request("/capabilities"))).json()).toMatchObject({ sessionActivityRequestIds: true })
    const response = await app.handle(request("/session-activity?sessionId=shared&requestId=request-a"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].requestId).toBe("request-a")
    expect(store.activities("shared", 50, "request-b")).toHaveLength(1)
    expect(store.activities("shared")).toHaveLength(3)
  } finally {
    store.close()
  }
})
