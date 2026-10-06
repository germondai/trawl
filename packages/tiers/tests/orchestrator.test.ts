import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { TierResult } from "@trawl/types"
import { type OrchestratorDeps, ScrapeError, scrape } from "../src/orchestrator"
import { ProxyPool } from "../src/utils/proxyRotator"

const payload = {
  html: "<html><body>Destination</body></html>",
  effectiveUrl: "https://example.test/final",
  body: new Uint8Array([1, 2, 3]),
  responseHeaders: { "set-cookie": "private-cookie=value" },
  contentType: "text/html",
  statusCode: 200,
  internalOnly: "must-not-leak",
}

function dependencies(minTier: TierResult["tier"], attempts: TierResult[]): OrchestratorDeps {
  const handle: BrowserHandle = {
    id: 1,
    lease: 1,
    headful: false,
    context: {},
    browser: {},
    fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
  }
  return {
    minTier,
    acquireBrowser: async () => handle,
    releaseBrowser: () => {},
    loadSession: async () => ({ cookies: [], userAgent: "cached-agent", savedAt: 1 }),
    saveSession: async () => {},
    invalidateSession: async () => {},
    residentialProxyPool: new ProxyPool(["http://residential.test:8080"]),
    onTierAttempt: (attempt) => attempts.push(attempt),
  }
}

function runners(status: TierResult["status"], reason?: string) {
  const result = { ...payload, status, durationMs: 12, ...(reason === undefined ? {} : { reason }) }
  return {
    tier1: async () => ({ ...result, tier: 1 as const }),
    tier2: async () => ({ ...result, tier: 2 as const }),
    tier3: async () => ({ ...result, tier: 3 as const }),
    tier4: async () => ({ ...result, tier: 4 as const }),
  }
}

describe("public tier attempt metadata", () => {
  for (const tier of [1, 2, 3, 4] as const) {
    for (const reason of [undefined, "completed"]) {
      test(`Tier ${tier} strips internal fields ${reason === undefined ? "without" : "with"} a reason`, async () => {
        const attempts: TierResult[] = []
        const result = await scrape(
          { url: "https://example.test", maxTier: tier },
          dependencies(tier, attempts),
          runners("success", reason),
        )
        const expected = [{ tier, status: "success", durationMs: 12, ...(reason === undefined ? {} : { reason }) }]
        expect(result.timings).toStrictEqual(expected)
        expect(attempts).toStrictEqual(expected)
        expect(result.html).toBe(payload.html)
        expect(result.body).toEqual(payload.body)
        expect(result.responseHeaders).toEqual(payload.responseHeaders)
      })
    }
  }

  test("filters every attempt during escalation", async () => {
    const attempts: TierResult[] = []
    const failed = runners("blocked", "challenge")
    const result = await scrape({ url: "https://example.test" }, dependencies(1, attempts), {
      ...failed,
      tier4: runners("success").tier4,
    })
    const expected = [
      { tier: 1, status: "blocked", durationMs: 12, reason: "challenge" },
      { tier: 2, status: "blocked", durationMs: 12, reason: "challenge" },
      { tier: 3, status: "blocked", durationMs: 12, reason: "challenge" },
      { tier: 4, status: "success", durationMs: 12 },
    ]
    expect(result.timings).toStrictEqual(expected)
    expect(attempts).toStrictEqual(expected)
  })

  test("filters failed attempts carried by ScrapeError", async () => {
    const attempts: TierResult[] = []
    let failure: unknown
    try {
      await scrape({ url: "https://example.test", maxTier: 1 }, dependencies(1, attempts), runners("error", "failed"))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ScrapeError)
    if (!(failure instanceof ScrapeError)) throw new Error("Expected scrape to fail")
    const expected = [{ tier: 1, status: "error", durationMs: 12, reason: "failed" }]
    expect(failure.timings).toStrictEqual(expected)
    expect(attempts).toStrictEqual(expected)
  })
})

describe("Anubis browser crash recovery", () => {
  for (const tier of [3, 4] as const) {
    test(`Tier ${tier} retries one closed page with the same routing and remaining budget`, async () => {
      const attempts: TierResult[] = []
      const calls: unknown[][] = []
      const crashRunner = async (...args: unknown[]) => {
        calls.push(args)
        if (calls.length === 1) {
          await Bun.sleep(5)
          return { tier, status: "error" as const, reason: "anubis-browser-closed", durationMs: 5 }
        }
        return { ...payload, tier, status: "success" as const, durationMs: 1 }
      }
      const proxy = "http://proxy.test:8080"
      const result = await scrape(
        {
          url: "https://example.test",
          proxy,
          maxTier: tier,
          maxTimeout: 1000,
          headers: { "X-Fixture": "yes" },
          ignoreCertificateErrors: true,
        },
        dependencies(tier, attempts),
        { ...runners("success"), ...(tier === 3 ? { tier3: crashRunner } : { tier4: crashRunner }) },
      )
      expect(result.tier).toBe(tier)
      expect(calls).toHaveLength(2)
      expect(calls[1]?.[3]).toBe(proxy)
      expect(calls[1]?.[4]).toEqual(calls[0]?.[4])
      expect(calls[1]?.[10]).toBe(true)
      expect(calls[1]?.[2] as number).toBeLessThan(calls[0]?.[2] as number)
      expect(attempts.map((attempt) => attempt.status)).toEqual(["error", "success"])
    })
  }

  test.each([
    { method: "POST" as const, reason: "anubis-browser-closed", expectedCalls: 1 },
    { method: "GET" as const, reason: "unrelated-browser-error", expectedCalls: 1 },
    { method: "GET" as const, reason: "anubis-browser-closed", expectedCalls: 2 },
  ])("bounds retries for $method and $reason", async ({ method, reason, expectedCalls }) => {
    let calls = 0
    await expect(
      scrape({ url: "https://example.test", method, maxTier: 3, maxTimeout: 1000 }, dependencies(3, []), {
        tier3: async () => {
          calls++
          return { tier: 3, status: "error", reason, durationMs: 1 }
        },
      }),
    ).rejects.toBeInstanceOf(ScrapeError)
    expect(calls).toBe(expectedCalls)
  })

  test("does not retry after the request deadline", async () => {
    let calls = 0
    await expect(
      scrape({ url: "https://example.test", maxTier: 3, maxTimeout: 10 }, dependencies(3, []), {
        tier3: async () => {
          calls++
          await Bun.sleep(20)
          return { tier: 3, status: "error", reason: "anubis-browser-closed", durationMs: 20 }
        },
      }),
    ).rejects.toBeInstanceOf(ScrapeError)
    expect(calls).toBe(1)
  })

  test("does not retry a disconnected browser", async () => {
    let calls = 0
    const deps = dependencies(3, [])
    const acquire = deps.acquireBrowser
    deps.acquireBrowser = async (...args) => {
      const handle = await acquire(...args)
      handle.browser = { isConnected: () => false }
      return handle
    }
    await expect(
      scrape({ url: "https://example.test", maxTier: 3 }, deps, {
        tier3: async () => {
          calls++
          return { tier: 3, status: "error", reason: "anubis-browser-closed", durationMs: 1 }
        },
      }),
    ).rejects.toBeInstanceOf(ScrapeError)
    expect(calls).toBe(1)
  })

  test("shares the single retry between browser tiers", async () => {
    const calls = { tier3: 0, tier4: 0 }
    await expect(
      scrape({ url: "https://example.test", maxTier: 4 }, dependencies(3, []), {
        tier3: async () => {
          calls.tier3++
          return { tier: 3, status: "error", reason: "anubis-browser-closed", durationMs: 1 }
        },
        tier4: async () => {
          calls.tier4++
          return { tier: 4, status: "error", reason: "anubis-browser-closed", durationMs: 1 }
        },
      }),
    ).rejects.toBeInstanceOf(ScrapeError)
    expect(calls).toEqual({ tier3: 2, tier4: 1 })
  })
})
