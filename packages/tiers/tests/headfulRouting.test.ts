import { afterAll, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { AcquireOptions, OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { DATADOME_INTERSTITIAL } from "./fixtures/datadome"

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/datadome") {
      return new Response(DATADOME_INTERSTITIAL, {
        status: 403,
        headers: { "content-type": "text/html", "x-dd-b": "1" },
      })
    }
    return new Response("<html><head><title>Just a moment...</title></head><body></body></html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })
  },
})

afterAll(() => server.stop(true))

const baseUrl = `http://127.0.0.1:${server.port}`

const browserHandle = (headful: boolean): BrowserHandle => ({
  id: 0,
  lease: headful ? 2 : 1,
  headful,
  context: {},
  browser: {},
  fingerprint: { userAgent: "test", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
})

// The stub throws once the routing decision is visible: acquiring is as far as this test
// needs to run.
function recordingDeps() {
  const acquired: Array<AcquireOptions | undefined> = []
  const deps: OrchestratorDeps = {
    acquireBrowser: async (_domain, _budgetMs, options) => {
      acquired.push(options)
      throw new Error("routing recorded")
    },
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  return { deps, acquired }
}

describe("headful pool routing", () => {
  test("a DataDome wall in Tier 1 asks for a headful browser", async () => {
    const { deps, acquired } = recordingDeps()
    await scrape({ url: `${baseUrl}/datadome` }, deps).catch(() => {})
    expect(acquired).toEqual([{ headful: true, signal: expect.any(AbortSignal) }])
  })

  test("every other wall stays on the headless pool", async () => {
    const { deps, acquired } = recordingDeps()
    await scrape({ url: `${baseUrl}/cloudflare` }, deps).catch(() => {})
    expect(acquired).toEqual([{ headful: false, signal: expect.any(AbortSignal) }])
  })

  test("a request that skips Tier 1 cannot know the wall and stays headless", async () => {
    const { deps, acquired } = recordingDeps()
    await scrape({ url: `${baseUrl}/datadome`, skipHttp: true }, deps).catch(() => {})
    expect(acquired).toEqual([{ headful: false, signal: expect.any(AbortSignal) }])
  })

  test("retries a late Tier 2 DataDome wall once with a headful lease", async () => {
    const acquired: boolean[] = []
    const released: boolean[] = []
    let calls = 0
    const deps: OrchestratorDeps = {
      acquireBrowser: async (_domain, _budget, options) => {
        const headful = options?.headful === true
        acquired.push(headful)
        return browserHandle(headful)
      },
      releaseBrowser: (handle) => released.push(handle.headful),
      loadSession: async () => ({ cookies: [], userAgent: "cached", savedAt: Date.now() }),
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const result = await scrape({ url: "https://example.test", skipHttp: true, maxTier: 2 }, deps, {
      tier2: async (_url, handle) => {
        calls++
        return handle.headful
          ? { tier: 2, status: "success", durationMs: 1, html: "<html>ok</html>", statusCode: 200 }
          : { tier: 2, status: "blocked", durationMs: 1, reason: "datadome-session-expired", challenge: "datadome" }
      },
    })
    expect(result.tier).toBe(2)
    expect(calls).toBe(2)
    expect(acquired).toEqual([false, true])
    expect(released).toEqual([false, true])
    expect(Object.hasOwn(result.timings[0] ?? {}, "challenge")).toBeFalse()
  })

  test("retries Tier 3 once and preserves an explicit SOCKS proxy", async () => {
    const proxies: Array<string | undefined> = []
    const acquired: boolean[] = []
    const deps: OrchestratorDeps = {
      acquireBrowser: async (_domain, _budget, options) => {
        const headful = options?.headful === true
        acquired.push(headful)
        return browserHandle(headful)
      },
      releaseBrowser: () => {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const result = await scrape(
      { url: "https://example.test", skipHttp: true, maxTier: 3, proxy: "socks5://proxy.test:1080" },
      deps,
      {
        tier3: async (_url, handle, _timeout, proxy) => {
          proxies.push(proxy)
          return handle.headful
            ? { tier: 3, status: "success", durationMs: 1, html: "<html>ok</html>", statusCode: 200 }
            : { tier: 3, status: "blocked", durationMs: 1, reason: "datadome-persistent", challenge: "datadome" }
        },
      },
    )
    expect(result.proxyUsed).toBeTrue()
    expect(acquired).toEqual([false, true])
    expect(proxies).toEqual(["socks5://proxy.test:1080", "socks5://proxy.test:1080"])
  })

  test("preserves the explicit HTTP proxy selected by a Tier 1 DataDome response", async () => {
    const proxies: Array<string | undefined> = []
    const acquired: boolean[] = []
    const deps: OrchestratorDeps = {
      acquireBrowser: async (_domain, _budget, options) => {
        const headful = options?.headful === true
        acquired.push(headful)
        return browserHandle(headful)
      },
      releaseBrowser: () => {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const result = await scrape({ url: "http://target.invalid/datadome", maxTier: 3, proxy: baseUrl }, deps, {
      tier3: async (_url, _handle, _timeout, proxy) => {
        proxies.push(proxy)
        return { tier: 3, status: "success", durationMs: 1, html: "<html>ok</html>", statusCode: 200 }
      },
    })
    expect(result.tier).toBe(3)
    expect(acquired).toEqual([true])
    expect(proxies).toEqual([baseUrl])
  })

  test("preserves an explicit HTTPS proxy after Tier 1 detects DataDome", async () => {
    const originalFetch = globalThis.fetch
    const proxies: Array<string | undefined> = []
    const fetchProxies: Array<string | undefined> = []
    globalThis.fetch = (async (_input, init) => {
      fetchProxies.push((init as (RequestInit & { proxy?: string }) | undefined)?.proxy)
      return new Response(DATADOME_INTERSTITIAL, {
        status: 403,
        headers: { "content-type": "text/html", "x-dd-b": "1" },
      })
    }) as typeof fetch
    const deps: OrchestratorDeps = {
      acquireBrowser: async (_domain, _budget, options) => browserHandle(options?.headful === true),
      releaseBrowser: () => {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    try {
      const result = await scrape({ url: "https://example.test", maxTier: 3, proxy: "https://proxy.test:8443" }, deps, {
        tier3: async (_url, _handle, _timeout, proxy) => {
          proxies.push(proxy)
          return { tier: 3, status: "success", durationMs: 1, html: "<html>ok</html>", statusCode: 200 }
        },
      })
      expect(result.tier).toBe(3)
      expect(fetchProxies).toEqual(["https://proxy.test:8443"])
      expect(proxies).toEqual(["https://proxy.test:8443"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retries Tier 3 once with the same configured datacenter proxy", async () => {
    const proxies: Array<string | undefined> = []
    const deps: OrchestratorDeps = {
      acquireBrowser: async (_domain, _budget, options) => browserHandle(options?.headful === true),
      releaseBrowser: () => {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
      proxyPool: {
        next: () => "https://datacenter.test:8443",
        markBad: () => {},
      } as unknown as OrchestratorDeps["proxyPool"],
    }
    const result = await scrape({ url: "https://example.test", skipHttp: true, maxTier: 3 }, deps, {
      tier3: async (_url, handle, _timeout, proxy) => {
        proxies.push(proxy)
        return handle.headful
          ? { tier: 3, status: "success", durationMs: 1, html: "<html>ok</html>", statusCode: 200 }
          : { tier: 3, status: "blocked", durationMs: 1, reason: "datadome-persistent", challenge: "datadome" }
      },
    })
    expect(result.tier).toBe(3)
    expect(proxies).toEqual(["https://datacenter.test:8443", "https://datacenter.test:8443"])
  })

  test("retries late Tier 4 detection with the same residential proxy", async () => {
    const proxies: string[] = []
    const deps: OrchestratorDeps = {
      acquireBrowser: async (_domain, _budget, options) => browserHandle(options?.headful === true),
      releaseBrowser: () => {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
      residentialProxyPool: {
        next: () => "http://residential.test:8080",
        markBad: () => {},
      } as unknown as OrchestratorDeps["residentialProxyPool"],
    }
    const result = await scrape({ url: "https://example.test", skipHttp: true }, deps, {
      tier3: async () => ({ tier: 3, status: "blocked", durationMs: 1, reason: "other-wall" }),
      tier4: async (_url, handle, _timeout, proxy) => {
        proxies.push(proxy)
        return handle.headful
          ? { tier: 4, status: "success", durationMs: 1, html: "<html>ok</html>", statusCode: 200 }
          : { tier: 4, status: "blocked", durationMs: 1, reason: "datadome-persistent", challenge: "datadome" }
      },
    })
    expect(result.tier).toBe(4)
    expect(proxies).toEqual(["http://residential.test:8080", "http://residential.test:8080"])
  })
})
