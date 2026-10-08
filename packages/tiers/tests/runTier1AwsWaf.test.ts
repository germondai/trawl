import { describe, expect, test } from "bun:test"
import { runTier1 } from "../src/tiers/1"
import { withFetch } from "./helpers/fetch"

describe("Tier 1 AWS WAF handling", () => {
  test("escalates Challenge from headers before consuming an open body and preserves metadata", async () => {
    const openBody = new ReadableStream<Uint8Array>({ start() {} })
    await withFetch(
      new Response(openBody, {
        status: 202,
        headers: { "X-Amzn-Waf-Action": "Challenge", "Content-Type": "text/html", "X-Test": "kept" },
      }),
      async () => {
        const result = await Promise.race([
          runTier1("https://example.test/"),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("body was consumed")), 100)),
        ])
        expect(result.status).toBe("needs-js")
        expect(result.reason).toBe("aws-waf-challenge")
        expect(result.statusCode).toBe(202)
        expect(result.responseHeaders?.["x-test"]).toBe("kept")
      },
    )
  })

  test("returns interactive CAPTCHA as explicitly blocked", async () => {
    await withFetch(new Response("", { status: 405, headers: { "x-amzn-waf-action": "captcha" } }), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("blocked")
      expect(result.reason).toBe("aws-waf-captcha-required")
      expect(result.statusCode).toBe(405)
    })
  })

  test("allows legitimate empty and non-empty 202 responses", async () => {
    for (const body of ["", "accepted"]) {
      await withFetch(new Response(body, { status: 202, headers: { "content-type": "text/plain" } }), async () => {
        const result = await runTier1("https://example.test/")
        expect(result.status).toBe("success")
        expect(result.html).toBe(body)
      })
    }
  })

  test("escalates only the combined HTML fallback markers", async () => {
    const challenge = `<script>window.gokuProps={}</script><script src="https://x.token.awswaf.com/x/challenge.js"></script>`
    await withFetch(new Response(challenge, { status: 200, headers: { "content-type": "text/html" } }), async () => {
      expect((await runTier1("https://example.test/")).reason).toBe("aws-waf-challenge")
    })
    await withFetch(
      new Response(`<script src="https://x.token.awswaf.com/x/challenge.js"></script>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      async () => {
        expect((await runTier1("https://example.test/")).status).toBe("success")
      },
    )
  })
})
