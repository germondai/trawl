import { afterEach, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { SessionData } from "@trawl/types"
import { type OrchestratorDeps, ScrapeError, scrape } from "../src/orchestrator"

const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
})

const browserHandle = (): BrowserHandle => ({
  id: 1,
  lease: 1,
  headful: false,
  context: {},
  browser: {},
  fingerprint: { userAgent: "browser-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
})

const session: SessionData = { cookies: [], userAgent: "cached-agent", savedAt: 1 }

function dependencies(
  minTier: 1 | 2 | 3 | 4 | undefined,
  events: string[],
  withResidentialProxy = false,
): OrchestratorDeps {
  return {
    minTier,
    acquireBrowser: async () => {
      events.push("acquire")
      return browserHandle()
    },
    releaseBrowser: () => events.push("release"),
    loadSession: async () => {
      events.push("load-session")
      return session
    },
    saveSession: async () => {},
    invalidateSession: async () => {
      events.push("invalidate-session")
    },
    residentialProxyPool: withResidentialProxy
      ? ({
          next: () => "http://residential.example:8080",
          markBad: () => {},
        } as unknown as OrchestratorDeps["residentialProxyPool"])
      : undefined,
  }
}

describe("deployment-wide minimum tier", () => {
  test("keeps the default Tier 1 fast path for an unrecognized HTTP 200 challenge", async () => {
    const events: string[] = []
    const challenge = "<html><title>Please verify</title><body>vendor-x browser verification required</body></html>"
    ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(challenge, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch

    const result = await scrape({ url: "https://example.test" }, dependencies(undefined, events))

    expect(result.tier).toBe(1)
    expect(result.html).toBe(challenge)
    expect(events).toEqual([])
  })

  test("Tier 2 floor skips plain HTTP and starts with a cached browser session", async () => {
    const events: string[] = []
    ;(globalThis as { fetch: typeof fetch }).fetch = (async () => {
      events.push("fetch")
      throw new Error("Tier 1 must be skipped")
    }) as unknown as typeof fetch

    const result = await scrape({ url: "https://example.test", maxTier: 2 }, dependencies(2, events), {
      tier2: async () => ({ tier: 2, status: "success", durationMs: 1, html: "<html>cached</html>" }),
    })

    expect(result.tier).toBe(2)
    expect(events).toEqual(["acquire", "load-session", "release"])
    expect(result.timings.map(({ tier }) => tier)).toEqual([2])
  })

  test("Tier 3 floor bypasses both plain HTTP and the session cache", async () => {
    const events: string[] = []
    const result = await scrape({ url: "https://example.test", maxTier: 3 }, dependencies(3, events), {
      tier2: async () => {
        throw new Error("Tier 2 must be skipped")
      },
      tier3: async () => ({ tier: 3, status: "success", durationMs: 1, html: "<html>fresh</html>" }),
    })

    expect(result.tier).toBe(3)
    expect(events).toEqual(["acquire", "release"])
    expect(result.timings.map(({ tier }) => tier)).toEqual([3])
  })

  test("Tier 4 floor starts directly with the configured residential proxy", async () => {
    const events: string[] = []
    const proxies: string[] = []
    const result = await scrape({ url: "https://example.test" }, dependencies(4, events, true), {
      tier3: async () => {
        throw new Error("Tier 3 must be skipped")
      },
      tier4: async (_url, _handle, _timeout, proxy) => {
        proxies.push(proxy)
        return { tier: 4, status: "success", durationMs: 1, html: "<html>residential</html>" }
      },
    })

    expect(result.tier).toBe(4)
    expect(proxies).toEqual(["http://residential.example:8080"])
    expect(events).toEqual(["acquire", "release"])
    expect(result.timings.map(({ tier }) => tier)).toEqual([4])
  })

  test("rejects an impossible floor and ceiling before network or browser work", async () => {
    const events: string[] = []
    const error = await scrape({ url: "https://example.test", maxTier: 2 }, dependencies(3, events)).catch(
      (cause) => cause,
    )

    expect(error).toBeInstanceOf(ScrapeError)
    expect(error.message).toBe("Minimum tier 3 exceeds max tier 2")
    expect(error.timings).toEqual([])
    expect(events).toEqual([])
  })

  test("fails a Tier 4 floor clearly when no eligible proxy exists", async () => {
    const events: string[] = []
    const error = await scrape({ url: "https://example.test" }, dependencies(4, events)).catch((cause) => cause)

    expect(error).toBeInstanceOf(ScrapeError)
    expect(error.message).toBe("Tier 4 requires RESIDENTIAL_PROXY_URL or a per-request proxy.")
    expect(error.timings).toEqual([])
    expect(events).toEqual([])
  })
})
