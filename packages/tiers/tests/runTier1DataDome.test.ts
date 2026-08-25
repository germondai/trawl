import { describe, expect, test } from "bun:test"
import { runTier1 } from "../src/tiers/1"
import {
  DATADOME_CAPTCHA,
  DATADOME_INTERSTITIAL,
  DATADOME_JSON_HARD_BLOCK,
  DATADOME_TAGGED_PAGE,
} from "./fixtures/datadome"

async function withFetch(response: Response, run: () => Promise<void>) {
  const original = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async () => response) as typeof fetch
  try {
    await run()
  } finally {
    ;(globalThis as { fetch: typeof fetch }).fetch = original
  }
}

const html = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } })

describe("Tier 1 DataDome handling", () => {
  test("escalates the Device Check to a browser and keeps the response metadata", async () => {
    await withFetch(html(DATADOME_INTERSTITIAL, 403, { "x-dd-b": "1", "x-test": "kept" }), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("needs-js")
      expect(result.reason).toBe("datadome-interstitial")
      expect(result.statusCode).toBe(403)
      expect(result.responseHeaders?.["x-test"]).toBe("kept")
    })
  })

  test("reports the slider and the hard block as blocked, not as needing JS", async () => {
    await withFetch(html(DATADOME_CAPTCHA, 403), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("blocked")
      expect(result.reason).toBe("datadome-captcha-required")
    })
    await withFetch(html(DATADOME_JSON_HARD_BLOCK, 403, { "content-type": "application/json" }), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("blocked")
      expect(result.reason).toBe("datadome-blocked")
    })
  })

  test("escalates on the x-dd-b header even when the body is empty", async () => {
    await withFetch(html("", 403, { "x-dd-b": "1" }), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("needs-js")
      expect(result.reason).toBe("datadome-interstitial")
    })
  })

  test("serves an ordinary page of a protected site", async () => {
    await withFetch(html(DATADOME_TAGGED_PAGE, 200), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("success")
      expect(result.html).toContain("12 items")
    })
  })
})
