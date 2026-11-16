import { expect, test } from "bun:test"
import { Trawl } from "../src/index"

const id = "10000000-0000-4000-8000-000000000000"
const snapshot = {
  pages: [
    {
      id,
      browserId: 1,
      requestId: "request-one",
      source: "native",
      tier: 3,
      display: "headless",
      state: "request",
      origin: "https://owned.fixture",
      observedAt: "2026-11-16T10:00:00.000Z",
    },
  ],
  truncated: false,
  limits: { width: 1280, height: 720, maxBytes: 1048576, intervalMs: 1000, timeoutMs: 350 },
  headedDebug: { supported: true, configured: false, display: "host-window" },
}

test("browser observation uses authenticated read resources without a new scrape", async () => {
  const paths: string[] = []
  const api = new Trawl({
    baseURL: "https://instance.fixture",
    apiKey: "owned-dummy-token",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      paths.push(new URL(request.url).pathname)
      expect(request.headers.get("authorization")).toBe("Bearer owned-dummy-token")
      expect(request.method).toBe("GET")
      return paths.length === 1 ? Response.json(snapshot) : new Response(new Uint8Array([255, 216, 255, 217]))
    },
  })
  expect((await api.browser.list()).pages[0]?.requestId).toBe("request-one")
  expect(await api.browser.preview(id)).toEqual(new Uint8Array([255, 216, 255, 217]))
  expect(paths).toEqual(["/browser/pages", `/browser/pages/${id}/preview`])
  expect(() => api.browser.preview("../other")).toThrow("Invalid browser page ID")
})

test("untrusted browser metadata and oversized preview responses are rejected", async () => {
  for (const pages of [
    [{ ...snapshot.pages[0], origin: "https://owned.fixture/private?dummy=1" }],
    [{ ...snapshot.pages[0], id: "../other" }],
    Array(129).fill(snapshot.pages[0]),
  ]) {
    const api = new Trawl({ fetch: async () => Response.json({ ...snapshot, pages }) })
    await expect(api.browser.list()).rejects.toMatchObject({ kind: "protocol" })
  }
  const api = new Trawl({
    fetch: async () => new Response(new Uint8Array(1048577), { headers: { "content-length": "1048577" } }),
  })
  await expect(api.browser.preview(id)).rejects.toThrow("1 MiB")
})
