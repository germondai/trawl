import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import { runTier2 } from "../../tiers/src/tiers/2"
import { runTier3 } from "../../tiers/src/tiers/3"
import { runTier4 } from "../../tiers/src/tiers/4"
import type { BrowserHandle } from "../src/index"
import { launchAnubisBrowser } from "./helpers/anubisBrowser"

// Owned HTTP fixtures; Tier 4 uses a local forward proxy, not a paid provider.
describe.skipIf(process.env.TRAWL_RAW_TEXT_TESTS !== "1")("Camoufox raw text integration", () => {
  let browser: Browser
  let handle: BrowserHandle
  let server: ReturnType<typeof Bun.serve>
  let proxy: ReturnType<typeof Bun.serve>
  let proxyHits = 0
  const documents = [
    { name: "plain", type: "text/plain", text: 'const a_b = "<done>"' },
    { name: "json", type: "application/json", text: '{"ok":[1,2,3]}' },
    { name: "xml", type: "application/xml", text: '<?xml version="1.0"?><rss><item>ok</item></rss>' },
    { name: "whitespace", type: "text/plain", text: "  alpha\r\n\r\n\r\nbeta  \n" },
    { name: "empty", type: "text/plain", text: "" },
    { name: "latin1", type: "text/plain; charset=iso-8859-1", text: "café", bytes: Buffer.from([99, 97, 102, 233]) },
  ]

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/empty-html") return new Response("<html></html>", { headers: { "content-type": "text/html" } })
        if (path === "/denied")
          return new Response("denied", { status: 403, headers: { "content-type": "text/plain" } })
        const document = documents.find((item) => path === `/${item.name}`)
        return document
          ? new Response(document.bytes ?? document.text, { headers: { "content-type": document.type } })
          : new Response("Not found", { status: 404 })
      },
    })
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        proxyHits++
        const url = new URL(request.url)
        url.hostname = "127.0.0.1"
        return fetch(url, { redirect: "manual" })
      },
    })
    browser = await launchAnubisBrowser()
    handle = {
      browser,
      context: await browser.newContext(),
      id: 1,
      lease: 1,
      headful: false,
      fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    proxy?.stop(true)
    server?.stop(true)
  })

  const run = (tier: number, path: string) => {
    const url = `http://${tier === 4 ? "trawl-raw.test" : "127.0.0.1"}:${server.port}/${path}`
    if (tier === 2) return runTier2(url, handle, { cookies: [], userAgent: "test-agent", savedAt: 1 }, 15_000)
    if (tier === 3) return runTier3(url, handle, 15_000)
    return runTier4(url, handle, 15_000, `http://127.0.0.1:${proxy.port}`)
  }

  for (const tier of [2, 3, 4]) {
    for (const document of documents) {
      test(`Tier ${tier} preserves ${document.name}`, async () => {
        const result = await run(tier, document.name)
        expect(result.status).toBe("success")
        expect(result.html).toBe(document.text)
        expect(Buffer.from(result.body ?? [])).toEqual(document.bytes ?? Buffer.from(document.text))
        if (tier === 4) expect(proxyHits).toBeGreaterThan(0)
      }, 30_000)
    }
    if (tier > 2) {
      test(`Tier ${tier} still rejects an empty HTML document`, async () => {
        expect(await run(tier, "empty-html")).toMatchObject({ status: "error", reason: "page returned empty content" })
      }, 30_000)
      test(`Tier ${tier} still rejects a short non-HTML HTTP block`, async () => {
        expect(await run(tier, "denied")).toMatchObject({ status: "blocked", reason: "http-403" })
      }, 30_000)
    }
  }
})
