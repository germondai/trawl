import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { OrchestratorDeps } from "@trawl/tiers"
import { BrowserObservations, browserPreviewLimits } from "./browserObservation"
import { MetricsStore } from "./metrics"
import { observabilityRoute } from "./routes/observability"

function item<T>(values: readonly T[], index = 0): T {
  const value = values[index]
  if (value === undefined) throw new Error("Missing fixture item")
  return value
}

type Page = Parameters<NonNullable<OrchestratorDeps["observePage"]>>[0]
class FixturePage extends EventEmitter {
  calls: unknown[] = []
  closed = false
  viewport: { width: number; height: number } | null = { width: 1920, height: 1080 }
  shot: () => Promise<Buffer> = async () => Buffer.from([255, 216, 255, 217])
  url() {
    return "https://private:dummy@owned.fixture/private-path?token=dummy#fragment"
  }
  isClosed() {
    return this.closed
  }
  viewportSize() {
    return this.viewport
  }
  async screenshot(options: unknown) {
    this.calls.push(options)
    return this.shot()
  }
  get page() {
    return this as unknown as Page
  }
}
const owner = {
  requestId: "request-one",
  source: "native" as const,
  tier: 3 as const,
  browserId: 1,
  headful: false,
  remaining: () => 60000,
}

test("observations identify the actual page, redact URLs and restore a retained session after its request", async () => {
  const registry = new BrowserObservations(),
    page = new FixturePage()
  const session = registry.register(page.page, {
    sessionId: "session-one",
    browserId: 1,
    headful: false,
    busy: () => false,
  })
  const id = registry.snapshot().pages[0]?.id
  const request = registry.register(page.page, { ...owner, sessionId: "session-one" })
  expect(registry.snapshot().pages).toMatchObject([
    { id, requestId: "request-one", sessionId: "session-one", origin: "https://owned.fixture", state: "request" },
  ])
  expect(JSON.stringify(registry.snapshot())).not.toMatch(/private-path|dummy|token|fragment/)
  expect(page.calls).toHaveLength(0)
  request()
  request()
  expect(registry.snapshot().pages).toMatchObject([{ id, sessionId: "session-one", state: "session-idle" }])
  expect(registry.snapshot().pages[0]?.requestId).toBeUndefined()
  session()
  expect(registry.snapshot().pages).toEqual([])
  expect(page.eventNames()).toEqual([])
  registry.close()
})

test("one-shot previews reuse the current page, clip CSS pixels and enforce global rate and cache bounds", async () => {
  let now = 1000
  const registry = new BrowserObservations(() => now),
    pages = [new FixturePage(), new FixturePage(), new FixturePage()]
  const releases = pages.map((page) => registry.register(page.page, owner))
  const ids = registry.snapshot().pages.map((page) => page.id)
  item(pages).viewport = null
  const first = await registry.preview(item(ids, 0))
  expect(await registry.preview(item(ids, 0))).toBe(first)
  expect(pages[0]?.calls).toEqual([
    {
      type: "jpeg",
      quality: 45,
      scale: "css",
      caret: "initial",
      timeout: 350,
      clip: { x: 0, y: 0, width: 1280, height: 720 },
    },
  ])
  await registry.preview(item(ids, 1))
  await expect(registry.preview(item(ids, 2))).rejects.toMatchObject({ status: 429 })
  now += 1001
  await registry.preview(item(ids, 2))
  expect(pages[2]?.calls).toHaveLength(1)
  for (const release of releases) release()
  await expect(registry.preview(item(ids, 0))).rejects.toMatchObject({ status: 404 })
  registry.close()
})

test("navigation, deadline and byte limits cannot publish a mismatched or unbounded image", async () => {
  let now = 1000
  const registry = new BrowserObservations(() => now),
    page = new FixturePage()
  let complete: (value: Buffer) => void = () => {}
  page.shot = () =>
    new Promise((resolve) => {
      complete = resolve
    })
  registry.register(page.page, owner)
  const id = item(registry.snapshot().pages).id
  const pending = registry.preview(id)
  await Promise.resolve()
  await expect(registry.preview(id)).rejects.toMatchObject({ status: 429 })
  page.emit("framenavigated", {})
  complete(Buffer.from([255, 216, 255, 217]))
  await expect(pending).rejects.toMatchObject({ status: 409 })
  now += 1001
  page.shot = async () => Buffer.alloc(browserPreviewLimits.maxBytes + 1)
  await expect(registry.preview(id)).rejects.toThrow("byte limit")
  const stop = registry.register(page.page, { ...owner, remaining: () => 1000 })
  await expect(registry.preview(id)).rejects.toThrow("budget")
  expect(page.calls).toHaveLength(2)
  stop()
  registry.close()
})

test("timed-out protocol operations keep their slots until they settle", async () => {
  let now = 1000
  const registry = new BrowserObservations(() => now),
    pages = [new FixturePage(), new FixturePage(), new FixturePage()]
  const finish: Array<(bytes: Buffer) => void> = []
  for (const page of pages) {
    page.shot = () => new Promise((resolve) => finish.push(resolve))
    registry.register(page.page, owner)
  }
  const ids = registry.snapshot().pages.map((page) => page.id)
  await Promise.all(ids.slice(0, 2).map((id) => expect(registry.preview(id)).rejects.toThrow("timed out")))
  now += 2000
  await expect(registry.preview(item(ids, 2))).rejects.toMatchObject({ status: 429 })
  for (const resolve of finish) resolve(Buffer.from([255, 216, 255, 217]))
  await Bun.sleep(0)
  item(pages, 2).shot = async () => Buffer.from([255, 216, 255, 217])
  expect((await registry.preview(item(ids, 2))).byteLength).toBe(4)
  registry.close()
})

test("registry limits and page closure release references without closing unrelated pages", () => {
  const registry = new BrowserObservations(),
    pages = Array.from({ length: 129 }, () => new FixturePage())
  const releases = pages.map((page) => registry.register(page.page, owner))
  expect(registry.snapshot().pages).toHaveLength(128)
  expect(registry.snapshot().truncated).toBe(true)
  releases[128]?.()
  releases[128]?.()
  expect(registry.snapshot().truncated).toBe(false)
  pages[0]?.emit("close")
  expect(registry.snapshot().pages).toHaveLength(127)
  expect(pages.every((page) => !page.closed)).toBe(true)
  registry.close()
  expect(pages.every((page) => page.listenerCount("close") === 0)).toBe(true)
})

test("browser observation endpoints require their token and never acquire a browser", async () => {
  const secret = "owned-browser-observation-token-abcdefghijklmnopqrstuvwxyz"
  const registry = new BrowserObservations(),
    metrics = new MetricsStore(),
    page = new FixturePage()
  registry.register(page.page, owner)
  const id = item(registry.snapshot().pages).id
  const app = observabilityRoute({ enabled: true, secret, observations: registry, store: metrics })
  const request = (path: string, auth = true) =>
    new Request(`http://localhost${path}`, { headers: auth ? { authorization: `Bearer ${secret}` } : {} })
  try {
    for (const path of ["/browser/pages", `/browser/pages/${id}/preview`])
      expect((await app.handle(request(path, false))).status).toBe(401)
    const snapshot = await (await app.handle(request("/browser/pages"))).json()
    expect(snapshot.pages[0].id).toBe(id)
    expect(page.calls).toHaveLength(0)
    const response = await app.handle(request(`/browser/pages/${id}/preview`))
    expect(response.headers.get("content-type")).toBe("image/jpeg")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 217]))
    expect(page.calls).toHaveLength(1)
  } finally {
    registry.close()
    metrics.close()
  }
})
