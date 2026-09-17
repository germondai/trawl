import { afterAll, describe, expect, test } from "bun:test"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { createCrossedLandingGuard, hostOf, isSameSite, probeLandingHost } from "../src/utils/crossedLanding"

// The page a wrong origin would serve under the requested domain's name.
const OTHER_SITE = "<html><body>an unrelated site</body></html>"

// Two hosts that resolve to the same machine, so a redirect between them is a real
// cross-host landing as far as the guard is concerned.
const wrongOrigin = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(OTHER_SITE, { headers: { "Content-Type": "text/html" } }),
})

const requestedOrigin = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/elsewhere") return Response.redirect(`http://127.0.0.1:${wrongOrigin.port}/landed`, 302)
    return new Response("<html><body>the requested site</body></html>", { headers: { "Content-Type": "text/html" } })
  },
})

afterAll(() => {
  requestedOrigin.stop(true)
  wrongOrigin.stop(true)
})

// `localhost` and `127.0.0.1` are the same machine but different hosts — the requested URL
// uses one, the redirect lands on the other.
const requestedUrl = `http://localhost:${requestedOrigin.port}/elsewhere`
const landedHost = "127.0.0.1"

const deps = (landingProbe?: OrchestratorDeps["landingProbe"]): OrchestratorDeps => ({
  acquireBrowser: async () => {
    throw new Error("Tier 1 should settle this request without a browser")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
  landingProbe,
})

describe("host comparison", () => {
  test("reads the host out of a URL and normalizes it", () => {
    expect(hostOf("https://Example.COM./path?q=1")).toBe("example.com")
    expect(hostOf("not a url")).toBeNull()
    expect(hostOf(undefined)).toBeNull()
  })

  test("treats a host and its subdomains as the same site", () => {
    expect(isSameSite("example.com", "example.com")).toBe(true)
    expect(isSameSite("example.com", "www.example.com")).toBe(true)
    expect(isSameSite("login.example.com", "example.com")).toBe(true)
    expect(isSameSite("example.com", "example.com.attacker.io")).toBe(false)
    expect(isSameSite("bank.co.uk", "evil.co.uk")).toBe(false)
  })
})

describe("crossed-landing guard", () => {
  test("a landing on the requested site is kept without probing", async () => {
    let probed = 0
    const guard = createCrossedLandingGuard("https://example-bank.test/", async () => {
      probed++
      return "example-bank.test"
    })

    expect(await guard.check("https://www.example-bank.test/home", {})).toBeNull()
    expect(probed).toBe(0)
  })

  test("a landing the requested URL does not lead to is refused", async () => {
    const guard = createCrossedLandingGuard("https://example-bank.test/", async () => "example-bank.test")

    expect(await guard.check("https://unrelated-site.test/", {})).toBe("unrelated-site.test")
  })

  test("a probe that cannot answer keeps the scrape", async () => {
    const guard = createCrossedLandingGuard("https://example-bank.test/", async () => null)

    expect(await guard.check("https://unrelated-site.test/", {})).toBeNull()
  })

  test("a probe that lands off-site too is a redirect, not a crossing", async () => {
    const guard = createCrossedLandingGuard("https://old-shop.test/", async () => "new-shop.test")

    expect(await guard.check("https://new-shop.test/", {})).toBeNull()
  })

  test("the same off-site landing reached from two egresses is accepted as a browser-only redirect", async () => {
    const guard = createCrossedLandingGuard("https://old-shop.test/", async () => "old-shop.test")

    expect(await guard.check("https://new-shop.test/", {})).toBe("new-shop.test")
    expect(await guard.check("https://new-shop.test/", { proxy: "http://proxy.example:8080" })).toBeNull()
  })

  test("the same egress repeating itself is not a confirmation", async () => {
    const guard = createCrossedLandingGuard("https://example-bank.test/", async () => "example-bank.test")
    const sameEgress = { proxy: "http://proxy.example:8080" }

    expect(await guard.check("https://unrelated-site.test/", sameEgress)).toBe("unrelated-site.test")
    expect(await guard.check("https://unrelated-site.test/", sameEgress)).toBe("unrelated-site.test")
  })

  test("the probe is given the egress and user agent the scrape used", async () => {
    const seen: unknown[] = []
    const guard = createCrossedLandingGuard("https://example-bank.test/", async (_url, options) => {
      seen.push(options)
      return null
    })

    await guard.check("https://unrelated-site.test/", {
      proxy: "http://proxy.example:8080",
      userAgent: "scrape-agent",
      ignoreCertificateErrors: true,
    })

    expect(seen).toEqual([
      { proxy: "http://proxy.example:8080", userAgent: "scrape-agent", ignoreCertificateErrors: true },
    ])
  })

  test("the default probe reports the host a plain fetch ends on", async () => {
    expect(await probeLandingHost(requestedUrl, {})).toBe(landedHost)
    expect(await probeLandingHost(`http://localhost:${requestedOrigin.port}/`, {})).toBe("localhost")
    expect(await probeLandingHost("http://127.0.0.1:1/", {})).toBeNull()
  })

  test("the probe validates every redirect hop against the outbound policy", async () => {
    const validated: string[] = []
    const host = await probeLandingHost(requestedUrl, {
      validateOutboundUrl: async (url) => {
        validated.push(url)
      },
    })

    expect(host).toBe(landedHost)
    expect(validated).toEqual([requestedUrl, `http://127.0.0.1:${wrongOrigin.port}/landed`])
  })

  test("a hop the outbound policy refuses makes the probe inconclusive", async () => {
    const host = await probeLandingHost(requestedUrl, {
      validateOutboundUrl: async (url) => {
        if (!url.includes("/elsewhere")) throw new Error("blocked by outbound policy")
      },
    })

    expect(host).toBeNull()
  })
})

describe("scrape refuses a crossed landing", () => {
  test("an opted-in scrape whose page came from another host fails instead of returning it", async () => {
    const probed: string[] = []
    const scraped = scrape(
      { url: requestedUrl, maxTier: 1, ignoreCertificateErrors: true },
      deps(async (url) => {
        probed.push(url)
        return "localhost"
      }),
    )

    await expect(scraped).rejects.toThrow(/refused crossed landing on 127\.0\.0\.1/)
    expect(probed).toEqual([requestedUrl])
  })

  test("the refusal is recorded against the tier that produced it", async () => {
    const attempts: { status: string; reason?: string }[] = []
    await scrape(
      { url: requestedUrl, maxTier: 1, ignoreCertificateErrors: true },
      { ...deps(async () => "localhost"), onTierAttempt: (result) => attempts.push(result) },
    ).catch(() => {})

    expect(attempts).toEqual([
      { tier: 1, status: "error", durationMs: expect.any(Number), reason: "crossed-landing on 127.0.0.1" },
    ])
  })

  test("an inconclusive probe keeps the page", async () => {
    const result = await scrape(
      { url: requestedUrl, maxTier: 1, ignoreCertificateErrors: true },
      deps(async () => null),
    )

    expect(result.html).toContain("an unrelated site")
  })

  test("without the flag the landing is returned exactly as before, and nothing is probed", async () => {
    let probed = 0
    const result = await scrape(
      { url: requestedUrl, maxTier: 1 },
      deps(async () => {
        probed++
        return "localhost"
      }),
    )

    expect(result.html).toContain("an unrelated site")
    expect(result.url).toBe(`http://127.0.0.1:${wrongOrigin.port}/landed`)
    expect(probed).toBe(0)
  })
})
