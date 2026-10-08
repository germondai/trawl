import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { runTier1 } from "../src/tiers/1"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"

const html = `<html><body>${"Page content. ".repeat(20)}</body></html>`
const searchUrl = "https://www.google.com/search?q=trawl"
const sorryUrl = "https://www.google.com/sorry/index?continue=%2Fsearch"

describe("Google sorry final response", () => {
  test.each([sorryUrl, searchUrl])("Tier 1 classifies the final URL %s", async (finalUrl) => {
    const originalFetch = globalThis.fetch
    const response = new Response(html, { headers: { "content-type": "text/html" } })
    Object.defineProperty(response, "url", { value: finalUrl })
    globalThis.fetch = (async () => response) as unknown as typeof fetch
    try {
      const result = await runTier1(searchUrl)
      expect(result.status).toBe(finalUrl === sorryUrl ? "needs-js" : "success")
      if (finalUrl === sorryUrl) expect(result.reason).toBe("google-sorry-challenge")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  for (const tier of [2, 3, 4] as const) {
    test.each([sorryUrl, searchUrl])(`Tier ${tier} classifies the final URL %s`, async (finalUrl) => {
      let contextClosed = false
      const page = {
        url: () => finalUrl,
        title: async () => "Google",
        content: async () => html,
        goto: async () => {},
        on: () => {},
        frames: () => [],
        context: () => ({ cookies: async () => [] }),
        waitForLoadState: async () => {},
        setExtraHTTPHeaders: async () => {},
        evaluate: async () => "test-agent",
        close: async () => {},
      }
      const context = {
        newPage: async () => page,
        addCookies: async () => {},
        addInitScript: async () => {},
        cookies: async () => [],
        close: async () => {
          contextClosed = true
        },
      }
      const handle: BrowserHandle = {
        id: 1,
        lease: 1,
        headful: false,
        context,
        browser: { newContext: async () => context },
        fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
      }
      const result =
        tier === 2
          ? await runTier2(searchUrl, handle, { cookies: [], userAgent: "test-agent", savedAt: 1 }, 2000)
          : tier === 3
            ? await runTier3(searchUrl, handle, 2000)
            : await runTier4(searchUrl, handle, 2000, "http://proxy.test:8080")
      expect(result.status).toBe(finalUrl === sorryUrl ? "blocked" : "success")
      if (finalUrl === sorryUrl) expect(result.reason).toBe("google-sorry-persistent")
      if (tier !== 2) expect(contextClosed).toBe(true)
    })
  }
})
