import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { type OrchestratorDeps, ScrapeError, scrape } from "../src/orchestrator"

function unusedBrowserDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    acquireBrowser: async () => {
      throw new Error("browser should not be acquired")
    },
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
    ...overrides,
  }
}

describe("explicit proxy routing", () => {
  test("routes Tier 1 through an HTTP proxy without reaching the target directly", async () => {
    let targetRequests = 0
    let proxyRequests = 0
    const target = Bun.serve({
      port: 0,
      fetch: () => {
        targetRequests++
        return new Response("<html>direct</html>", { headers: { "content-type": "text/html" } })
      },
    })
    const proxy = Bun.serve({
      port: 0,
      fetch: () => {
        proxyRequests++
        return new Response("<html>proxy sentinel</html>", { headers: { "content-type": "text/html" } })
      },
    })

    try {
      const result = await scrape(
        { url: target.url.toString(), maxTier: 1, proxy: proxy.url.toString() },
        unusedBrowserDeps(),
      )
      expect(result.tier).toBe(1)
      expect(result.proxyUsed).toBeTrue()
      expect(result.html).toContain("proxy sentinel")
      expect(proxyRequests).toBe(1)
      expect(targetRequests).toBe(0)
    } finally {
      proxy.stop(true)
      target.stop(true)
    }
  })

  test("never invokes direct Tier 1 for an explicit SOCKS proxy", async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error("direct fetch must not run")
    }) as unknown as typeof fetch
    try {
      await expect(
        scrape(
          { url: "https://target.example", maxTier: 1, proxy: "socks5://proxy.example:1080" },
          unusedBrowserDeps(),
        ),
      ).rejects.toBeInstanceOf(ScrapeError)
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test.each([
    [407, {}, "proxy-authentication-failed"],
    [502, { "proxy-status": "fake-proxy; error=connection_timeout" }, "proxy-connection-failed"],
  ] as const)("fails immediately for definitive proxy response status %i", async (status, headers, reason) => {
    const proxy = Bun.serve({
      port: 0,
      fetch: () => new Response("proxy failure", { status, headers }),
    })
    try {
      const failure = scrape({ url: "https://target.example", proxy: proxy.url.toString() }, unusedBrowserDeps()).catch(
        (error: unknown) => error,
      )
      const error = await failure
      expect(error).toBeInstanceOf(ScrapeError)
      expect((error as ScrapeError).message).toBe(reason)
      expect((error as ScrapeError).timings[0]?.reason).toBe(reason)
    } finally {
      proxy.stop(true)
    }
  })

  test("fails instead of falling back direct when the explicit proxy is unreachable", async () => {
    const error = await scrape(
      { url: "https://target.example", proxy: "http://127.0.0.1:1" },
      unusedBrowserDeps(),
    ).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ScrapeError)
    expect((error as ScrapeError).message).toBe("proxy-connection-failed")
  })

  test("normalizes an HTTP/HTTPS proxy protocol mismatch", async () => {
    const plainHttpProxy = Bun.serve({
      port: 0,
      fetch: () => new Response("plain HTTP only"),
    })
    try {
      const wrongProtocolUrl = plainHttpProxy.url.toString().replace("http:", "https:")
      const error = await scrape({ url: "https://target.example", proxy: wrongProtocolUrl }, unusedBrowserDeps()).catch(
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(ScrapeError)
      expect((error as ScrapeError).message).toBe("proxy-connection-failed")
    } finally {
      plainHttpProxy.stop(true)
    }
  })

  test("does not load an unproxied Tier 2 session", async () => {
    let loadCalls = 0
    let released = false
    const handle = { id: 7, lease: 11 } as BrowserHandle
    const deps = unusedBrowserDeps({
      acquireBrowser: async () => handle,
      releaseBrowser: () => {
        released = true
      },
      loadSession: async () => {
        loadCalls++
        return { cookies: [], userAgent: "cached", savedAt: Date.now() }
      },
    })

    await expect(
      scrape(
        {
          url: "https://target.example",
          skipHttp: true,
          maxTier: 2,
          proxy: "http://proxy.example:8080",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ScrapeError)
    expect(loadCalls).toBe(0)
    expect(released).toBeTrue()
  })

  test("does not save explicit-proxy cookies into the domain session cache", async () => {
    let saveCalls = 0
    const handle = {
      id: 7,
      lease: 11,
      fingerprint: { userAgent: "browser", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    } as BrowserHandle
    const deps = unusedBrowserDeps({
      acquireBrowser: async () => handle,
      releaseBrowser: () => {},
      saveSession: async () => {
        saveCalls++
      },
    })

    const result = await scrape(
      {
        url: "https://target.example",
        skipHttp: true,
        maxTier: 3,
        proxy: "http://proxy.example:8080",
      },
      deps,
      {
        tier3: async () => ({
          tier: 3,
          status: "success",
          durationMs: 1,
          html: "<html>proxied</html>",
          cookies: [
            {
              name: "proxy-cookie",
              value: "secret",
              domain: "target.example",
              path: "/",
              expires: -1,
              httpOnly: false,
              secure: true,
            },
          ],
          userAgent: "proxied-browser",
          statusCode: 200,
        }),
      },
    )

    expect(result.tier).toBe(3)
    expect(result.proxyUsed).toBeTrue()
    expect(saveCalls).toBe(0)
  })

  test("relaxes browser certificate checks only for a proxy recognized by the caller", async () => {
    const handle = {
      id: 8,
      lease: 12,
      headful: false,
      fingerprint: { userAgent: "browser", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    } as BrowserHandle
    const seen: boolean[] = []
    const proxy = "http://127.0.0.1:8192"
    const deps = unusedBrowserDeps({
      acquireBrowser: async () => handle,
      trustedProxyCa: async (candidate) => (candidate === proxy ? "LOCAL CA" : undefined),
    })

    const result = await scrape({ url: "https://target.example", skipHttp: true, maxTier: 3, proxy }, deps, {
      tier3: async (...args) => {
        seen.push(args[10] === true)
        return {
          tier: 3,
          status: "success",
          durationMs: 1,
          html: "<html>trusted local proxy</html>",
          userAgent: "browser",
        }
      },
    })

    expect(result.statusCode).toBe(200)
    expect(seen).toEqual([true])
  })

  test("keeps strict browser certificate checks for an unrecognized explicit proxy", async () => {
    const handle = {
      id: 9,
      lease: 13,
      headful: false,
      fingerprint: { userAgent: "browser", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    } as BrowserHandle
    let ignored = true
    await scrape(
      { url: "https://target.example", skipHttp: true, maxTier: 3, proxy: "http://proxy.example:8080" },
      unusedBrowserDeps({ acquireBrowser: async () => handle, trustedProxyCa: async () => undefined }),
      {
        tier3: async (...args) => {
          ignored = args[10] === true
          return {
            tier: 3,
            status: "success",
            durationMs: 1,
            html: "<html>foreign proxy</html>",
            userAgent: "browser",
          }
        },
      },
    )
    expect(ignored).toBeFalse()
  })

  test("does not save explicit-proxy Tier 4 cookies into the domain session cache", async () => {
    let saveCalls = 0
    const handle = {
      id: 7,
      lease: 11,
      fingerprint: { userAgent: "browser", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    } as BrowserHandle
    const deps = unusedBrowserDeps({
      acquireBrowser: async () => handle,
      releaseBrowser: () => {},
      saveSession: async () => {
        saveCalls++
      },
    })

    const result = await scrape(
      {
        url: "https://target.example",
        skipHttp: true,
        proxy: "http://proxy.example:8080",
      },
      deps,
      {
        tier3: async () => ({ tier: 3, status: "blocked", durationMs: 1, reason: "proxy-ip-blocked" }),
        tier4: async () => ({
          tier: 4,
          status: "success",
          durationMs: 1,
          html: "<html>proxied Tier 4</html>",
          cookies: [
            {
              name: "proxy-cookie",
              value: "secret",
              domain: "target.example",
              path: "/",
              expires: -1,
              httpOnly: false,
              secure: true,
            },
          ],
          statusCode: 200,
        }),
      },
    )

    expect(result.tier).toBe(4)
    expect(result.proxyUsed).toBeTrue()
    expect(saveCalls).toBe(0)
  })

  test("retains the cached Tier 2 fast path without an explicit proxy", async () => {
    let loadCalls = 0
    const handle = {
      id: 7,
      lease: 11,
      fingerprint: { userAgent: "browser", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    } as BrowserHandle
    const deps = unusedBrowserDeps({
      acquireBrowser: async () => handle,
      releaseBrowser: () => {},
      loadSession: async () => {
        loadCalls++
        return { cookies: [], userAgent: "cached-browser", savedAt: Date.now() }
      },
    })

    const result = await scrape({ url: "https://target.example", skipHttp: true, maxTier: 2 }, deps, {
      tier2: async () => ({
        tier: 2,
        status: "success",
        durationMs: 1,
        html: "<html>cached</html>",
        statusCode: 200,
      }),
    })

    expect(result.tier).toBe(2)
    expect(result.sessionCached).toBeTrue()
    expect(result.proxyUsed).toBeFalse()
    expect(loadCalls).toBe(1)
  })

  test("retains session persistence for configured-pool escalation", async () => {
    let saveCalls = 0
    const handle = {
      id: 7,
      lease: 11,
      fingerprint: { userAgent: "browser", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    } as BrowserHandle
    const deps = unusedBrowserDeps({
      acquireBrowser: async () => handle,
      releaseBrowser: () => {},
      saveSession: async () => {
        saveCalls++
      },
      proxyPool: {
        next: () => "http://pool.example:8080",
        markBad: () => {},
      } as unknown as OrchestratorDeps["proxyPool"],
    })

    const result = await scrape({ url: "https://target.example", skipHttp: true, maxTier: 3 }, deps, {
      tier3: async () => ({
        tier: 3,
        status: "success",
        durationMs: 1,
        html: "<html>pool</html>",
        cookies: [
          {
            name: "pool-cookie",
            value: "ok",
            domain: "target.example",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
          },
        ],
        statusCode: 200,
      }),
    })

    expect(result.proxyUsed).toBeTrue()
    expect(saveCalls).toBe(1)
  })
})
