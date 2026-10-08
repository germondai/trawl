import { afterAll, describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { runTier1 } from "../src/tiers/1"
import { waitForAnubisResolution } from "../src/utils/anubisWait"
import { hasAnubisChallenge } from "../src/utils/detect"
import { ANUBIS_CHALLENGE } from "./fixtures/anubis"

// Regressions from the local Anubis audit: challenge and denial documents
// must not become successful content.
const denied = `<html><head><title>Oh noes!</title>
<script id="anubis_version" type="application/json">"v1.27.0"</script>
<script id="anubis_challenge" type="application/json">null</script></head>
<body><img src="/.within.website/x/cmd/anubis/static/img/reject.webp">
<p>Access denied: fixture-rule.</p><footer>Protected by Anubis</footer></body></html>`
const lateEnvelope = ANUBIS_CHALLENGE.replace("<head>", `<head><!--${"x".repeat(70_000)}-->`)
const origin = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    return new Response(new URL(request.url).pathname === "/denied" ? denied : lateEnvelope, {
      headers: { "Content-Type": "text/html" },
    })
  },
})
afterAll(() => origin.stop(true))

describe("Anubis audit regressions", () => {
  test("recognizes valid HTML with uppercase attribute names", () => {
    const html = ANUBIS_CHALLENGE.replace(/<script(?=[^>]*id="anubis_challenge")[^>]*>/g, (tag) =>
      tag.replace(/\bid=/g, "ID=").replace(/\btype=/g, "TYPE="),
    )
    expect(hasAnubisChallenge(html)).toBe(true)
  })

  test("does not return an Anubis DENY page at HTTP 200 as content", async () => {
    const result = await runTier1(new URL("/denied", origin.url).href)
    expect(result.status).not.toBe("success")
  })

  test("does not miss the challenge envelope after the HTTP preview limit", async () => {
    expect(hasAnubisChallenge(lateEnvelope)).toBe(true)
    const result = await runTier1(new URL("/late", origin.url).href)
    expect(result.status).not.toBe("success")
  })

  test("accepts a stable short destination after the challenge clears", async () => {
    let samples = 0
    const page = {
      evaluate: async () => (++samples === 1 ? { state: "challenge" } : { ready: true, content: true }),
      isClosed: () => false,
      url: () => "https://example.test/",
    } as unknown as Page
    expect(await waitForAnubisResolution(page, 1000)).toBe("ok")
  })
})
