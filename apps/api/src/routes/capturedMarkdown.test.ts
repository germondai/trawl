import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CaptureStore, defaultCapturePolicy } from "../captureStore"
import { MetricsStore } from "../metrics"
import { observabilityRoute } from "./observability"

test("saved Markdown authenticates retained HTML and bounds active transfers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-saved-markdown-"))
  const captureStore = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "html" })
  const store = new MetricsStore(true, ":memory:", true)
  const secret = "saved-content-test-token-at-least-32-characters"
  try {
    await captureStore.ready
    store.record({ requestId: "saved", source: "native", url: "https://owned.test", durationMs: 1, statusCode: 200 })
    const entry = store.request("saved")
    if (!entry) throw new Error("Missing retained fixture")
    captureStore.capture({
      requestId: entry.id,
      requestAt: entry.at,
      html: "<article><h1>Saved article</h1><p>A <strong>retained</strong> response.</p><pre><code>const value = 1;</code></pre></article>",
      contentType: "text/html",
    })
    await captureStore.flush()
    const app = observabilityRoute({ enabled: true, secret, store, captureStore })
    const get = (id: string, authorized = true) =>
      app.handle(
        new Request(`http://localhost/requests/${id}/markdown`, {
          headers: authorized ? { authorization: `Bearer ${secret}` } : {},
        }),
      )
    expect((await get("saved", false)).status).toBe(401)
    const response = await get("saved")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({ text: expect.stringContaining("# Saved article"), truncated: false })
    expect((await get("missing")).status).toBe(404)
    expect((await get("bad!id")).status).toBe(400)
    store.record({
      requestId: "json",
      source: "native",
      url: "https://owned.test/json",
      durationMs: 1,
      statusCode: 200,
    })
    const jsonEntry = store.request("json")
    if (!jsonEntry) throw new Error("Missing JSON fixture")
    captureStore.capture({
      requestId: "json",
      requestAt: jsonEntry.at,
      html: '{"ok":true}',
      contentType: "application/json",
    })
    await captureStore.flush()
    expect((await get("json")).status).toBe(404)
    store.record({
      requestId: "large",
      source: "native",
      url: "https://owned.test/large",
      durationMs: 1,
      statusCode: 200,
    })
    const large = store.request("large")
    if (!large) throw new Error("Missing retained fixture")
    captureStore.capture({
      requestId: large.id,
      requestAt: large.at,
      html: `<article><p>${"bounded response ".repeat(10000)}</p></article>`,
      contentType: "text/html",
    })
    await captureStore.flush()
    const held: Response[] = []
    try {
      for (let i = 0; i < 4; i++) held.push(await get("large"))
      expect(held.every((value) => value.status === 200)).toBe(true)
      expect((await get("large")).status).toBe(429)
      await held.shift()?.body?.cancel()
      held.push(await get("large"))
      expect(held.at(-1)?.status).toBe(200)
    } finally {
      await Promise.allSettled(held.map((value) => value.body?.cancel()))
    }
  } finally {
    await captureStore.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
