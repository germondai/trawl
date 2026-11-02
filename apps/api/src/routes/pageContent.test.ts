import { afterAll, describe, expect, test } from "bun:test"
import type { OrchestratorDeps } from "@trawl/tiers"
import { MetricsStore } from "../metrics"
import { scrapeRoute } from "./scrape"

let requests = 0
const html = `<html><head><title>Owned article</title></head><body><article><h1>Owned article</h1><p>${"Useful readable content. ".repeat(40)}</p><div class="card"><h2>First</h2><a href="/first">Link</a></div><div class="card"><h2>Second</h2></div></article></body></html>`
const origin = Bun.serve({
  port: 0,
  fetch(request) {
    requests++
    return new URL(request.url).pathname === "/raw"
      ? new Response("  alpha\r\n\r\nbeta  ", { headers: { "content-type": "text/plain" } })
      : new Response(html, { headers: { "content-type": "text/html" } })
  },
})
const store = new MetricsStore()
const deps: OrchestratorDeps = {
  acquireBrowser: async () => {
    throw new Error("HTTP fixtures must not acquire a browser")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
}
const app = scrapeRoute(
  () => deps,
  () => true,
  store,
)
const send = (path: string, body: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
const url = origin.url.href

afterAll(() => {
  origin.stop(true)
  store.close()
})

describe("native page content", () => {
  test("reads bounded markdown without returning raw HTML, cookies or navigation bytes", async () => {
    const response = await send("/read", { url, maxCharacters: 80 })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      title: "Owned article",
      format: "markdown",
      characters: 80,
      truncated: true,
      tier: 1,
      statusCode: 200,
    })
    expect(result.text).toContain("Useful readable content")
    expect(result.html).toBeUndefined()
    expect(result.body).toBeUndefined()
    expect(result.cookies).toBeUndefined()
  })

  test("uses the scraper's decoded plain text without applying HTML parsing", async () => {
    const source = await (await send("/scrape", { url: `${url}raw` })).json()
    const response = await send("/read", { url: `${url}raw`, format: "text", maxCharacters: 10 })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      text: source.html.slice(0, 10),
      format: "text",
      characters: 10,
      truncated: true,
    })
  })

  test("extracts bounded records and missing fields", async () => {
    const response = await send("/extract", {
      url,
      itemSelector: ".card",
      fields: { title: { selector: "h2" }, link: { selector: "a", attribute: "href" } },
      maxItems: 2,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      items: [
        { title: "First", link: "/first" },
        { title: "Second", link: null },
      ],
      matched: 2,
      truncated: false,
    })
  })

  test("validates content options before fetching", async () => {
    const before = requests
    for (const [path, extra] of [
      ["/read", { format: "html" }],
      ["/read", { maxCharacters: 100001 }],
      ["/extract", { fields: {} }],
      ["/extract", { fields: { title: { selector: "h1" } }, maxItems: 101 }],
      ["/extract", { render: true, maxTier: 1, fields: { title: { selector: "h1" } } }],
    ] as const)
      expect((await send(path, { url, ...extra })).status).toBe(400)
    expect(requests).toBe(before)
  })

  test("records transformation failures as failed requests once", async () => {
    const before = store.snapshot()
    const response = await send("/extract", { url, itemSelector: "[", fields: { title: { selector: "h1" } } })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain("Invalid itemSelector")
    const after = store.snapshot()
    expect(after.requests - before.requests).toBe(1)
    expect(after.failures - before.failures).toBe(1)
  })
})
