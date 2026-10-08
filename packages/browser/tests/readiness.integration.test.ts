import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import { runTier2 } from "../../tiers/src/tiers/2"
import { runTier3 } from "../../tiers/src/tiers/3"
import { runTier4 } from "../../tiers/src/tiers/4"
import type { CaptureOptions } from "../../tiers/src/utils/capture"
import type { BrowserHandle } from "../src/index"
import { launchAnubisBrowser } from "./helpers/anubisBrowser"

describe.skipIf(process.env.TRAWL_READINESS_TESTS !== "1")("browser readiness with ongoing traffic", () => {
  let browser: Browser
  let handle: BrowserHandle
  let server: ReturnType<typeof Bun.serve>
  let proxy: ReturnType<typeof Bun.serve>
  let proxyHits = 0

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/pending") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("pending"))
              },
            }),
          )
        }
        if (path === "/api/content") return Response.json({ value: "loaded" })
        if (path === "/api/slow") {
          await Bun.sleep(1100)
          return Response.json({ value: "loaded" })
        }
        return new Response(
          `<html><head><title>Owned document</title></head><body>
          <p>${"Real page content. ".repeat(20)}</p>
          <script>
            ${path === "/default" ? "" : "fetch('/pending').then(r => r.text()).catch(() => {});"}
            setTimeout(async () => {
              const data = await (await fetch('${path === "/default" ? "/api/slow" : "/api/content"}')).json();
              const node = document.createElement('h1'); node.id = 'ready'; node.textContent = data.value;
              document.body.append(node);
            }, ${path === "/default" ? 0 : 200});
          </script></body></html>`,
          { headers: { "content-type": "text/html", "cache-control": "no-store" } },
        )
      },
    })
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(request) {
        proxyHits++
        const url = new URL(request.url)
        url.hostname = "127.0.0.1"
        return fetch(url, { signal: request.signal, redirect: "manual" })
      },
    })
    browser = await launchAnubisBrowser()
    handle = {
      id: 1,
      lease: 1,
      headful: false,
      browser,
      context: await browser.newContext(),
      fingerprint: { userAgent: "fixture-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    proxy?.stop(true)
    server?.stop(true)
  })

  function run(tier: 2 | 3 | 4, path: string, capture: CaptureOptions = {}, timeout = 3000) {
    const url = `http://${tier === 4 ? "trawl-fixture.test" : "127.0.0.1"}:${server.port}${path}`
    return tier === 2
      ? runTier2(
          url,
          handle,
          { cookies: [], userAgent: "fixture-agent", savedAt: 1 },
          timeout,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          capture,
        )
      : tier === 3
        ? runTier3(url, handle, timeout, undefined, undefined, undefined, undefined, undefined, false, capture)
        : runTier4(
            url,
            handle,
            timeout,
            `http://127.0.0.1:${proxy.port}`,
            undefined,
            undefined,
            undefined,
            undefined,
            false,
            capture,
          )
  }

  for (const tier of [2, 3, 4] as const) {
    test(`Tier ${tier} captures ready content while an unrelated request remains open`, async () => {
      const result = await run(tier, "/", { contentWaitForSelector: "#ready", captureResponses: ["/api/content"] })
      expect(result.status, result.reason).toBe("success")
      expect(result.html).toContain('<h1 id="ready">loaded</h1>')
      expect(result.capturedResponses?.[0]?.body).toContain('"value":"loaded"')
      if (tier === 4) expect(proxyHits).toBeGreaterThan(0)
    }, 10_000)

    test(`Tier ${tier} preserves delayed JavaScript content with default readiness`, async () => {
      const result = await run(tier, "/default", {}, 5000)
      expect(result.status, result.reason).toBe("success")
      expect(result.html).toContain('<h1 id="ready">loaded</h1>')
    }, 10_000)
  }
})
