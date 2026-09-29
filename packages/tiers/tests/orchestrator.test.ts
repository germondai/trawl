import { afterEach, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { ScrapeRequest, SessionData } from "@trawl/types"
import { type OrchestratorDeps, scrape } from "../src/orchestrator"

const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
})

const mockBrowserHandle = (): BrowserHandle => ({
  id: 1,
  lease: 1,
  headful: false,
  context: {},
  browser: {},
  fingerprint: { userAgent: "test-ua", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
})

const mockSession: SessionData = { cookies: [], userAgent: "cached-agent", savedAt: 1 }

function mockDeps(): OrchestratorDeps {
  return {
    acquireBrowser: async () => mockBrowserHandle(),
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
    validateOutboundUrl: async () => {},
  }
}

describe("orchestrator", () => {
  test("emit correctly filters fields in timings array", async () => {
    const req: ScrapeRequest = {
      url: "https://example.com",
      method: "GET",
      headers: {},
      maxTier: 1,
    }

    const mockRunTier1 = async (
      url: string,
      headers: Record<string, string>,
      method: string,
      body?: string,
      proxy?: string,
      validateOutboundUrl?: (url: string) => Promise<void>,
    ): Promise<any> => {
      return {
        tier: 1,
        status: "success",
        durationMs: 100,
        reason: "success",
        challenge: "none",
        effectiveUrl: "https://example.com/success",
        html: "<html></html>",
        body: new Uint8Array([1, 2, 3]),
        responseHeaders: {},
        contentType: "text/html",
        statusCode: 200,
        // These are the "dirty" fields that should be filtered out
        leakedField1: "should-not-be-here",
        leakedField2: "should-not-be-here",
      }
    }

    const runners = {
      tier1: mockRunTier1,
    }

    const result = await scrape(req, mockDeps(), runners)

    // Check that timings only contains the allowed 4 fields
    result.timings.forEach((timing) => {
      expect(timing).toHaveProperty("tier", 1)
      expect(timing).toHaveProperty("status", "success")
      expect(timing).toHaveProperty("durationMs", 100)
      expect(timing).toHaveProperty("reason", "success")

      // Assert that no other keys exist
      const keys = Object.keys(timing)
      const allowedKeys = ["tier", "status", "durationMs", "reason"]
      keys.forEach((key) => {
        expect(allowedKeys).toContain(key)
      })
    })
  })
})