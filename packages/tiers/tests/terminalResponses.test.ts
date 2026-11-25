import { afterAll, describe, expect, test } from "bun:test"
import { type OrchestratorDeps, ScrapeError, scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { persistentBrowserWall } from "../src/utils/browserWall"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { detectChallengeType, isBlocked, isCloudflarePage, terminalResponseFailure } from "../src/utils/detect"
import { ProxyPool } from "../src/utils/proxyRotator"
import {
  ACCESS_DENIED,
  CLOUDFLARE_ORIGIN_ERROR,
  ORDINARY_RESPONSE_CONTROLS,
  VERIFICATION_REQUIRED,
} from "./fixtures/terminalResponses"

const ORIGIN_ERROR_CODES = [520, 521, 522, 523, 524, 525, 526] as const
const originError = (code: number) => CLOUDFLARE_ORIGIN_ERROR.replaceAll("522", String(code))

describe("terminal response classification", () => {
  test.each([ACCESS_DENIED, VERIFICATION_REQUIRED])("rejects an HTTP 200 access wall", (html) => {
    expect(isBlocked(200, html)).toBe(true)
    expect(persistentBrowserWall(html, "https://fixture.example/", {}, 200, "none")).toBeDefined()
  })

  test("does not send a Cloudflare origin failure through its challenge waiter", () => {
    expect(isCloudflarePage(CLOUDFLARE_ORIGIN_ERROR, { server: "cloudflare" })).toBe(false)
    expect(detectChallengeType(CLOUDFLARE_ORIGIN_ERROR, { server: "cloudflare" }, 522)).toBe("none")
  })

  test.each(ORIGIN_ERROR_CODES)("recognizes the known Cloudflare %i origin template", (code) => {
    const html = originError(code)
    expect(terminalResponseFailure(html)).toEqual({ status: "error", reason: `cloudflare-origin-http-${code}` })
    expect(isCloudflarePage(html, { server: "cloudflare" })).toBe(false)
    expect(detectChallengeType(html, {}, code)).toBe("none")
    expect(terminalResponseFailure(html, { "cf-mitigated": "challenge" })).toBeUndefined()
    expect(isCloudflarePage(html, { "cf-mitigated": "challenge" })).toBe(true)
  })

  test.each([500, 502, 503, 504, 527, 530])("does not extend terminal origin detection to HTTP %i", (code) => {
    expect(terminalResponseFailure(originError(code))).toBeUndefined()
  })

  test("keeps a genuine HTTP 503 challenge in its solver path", async () => {
    const html =
      "<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>"
    expect(terminalResponseFailure(html)).toBeUndefined()
    let waited = false
    const cloudflare = async () => {
      waited = true
      return "ok" as const
    }
    expect(await routeChallengeWait({} as never, html, {}, 1000, undefined, { cloudflare } as never, 503)).toEqual({
      challengeType: "cloudflare-interstitial",
      resolution: "ok",
    })
    expect(waited).toBe(true)
  })

  test("recognizes an encoded plain-text Akamai error reference", () => {
    const html = ACCESS_DENIED.replace(
      /<a[^>]*>.*?<\/a>/,
      "https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18.1234",
    )
    expect(terminalResponseFailure(html)).toEqual({ status: "blocked", reason: "akamai-access-denied" })
  })

  test.each([ACCESS_DENIED, VERIFICATION_REQUIRED, CLOUDFLARE_ORIGIN_ERROR])(
    "HTML attributes are case insensitive",
    (html) => {
      expect(
        terminalResponseFailure(
          html.replaceAll("href=", "HREF=").replaceAll("action=", "ACTION=").replaceAll("id=", "ID="),
        ),
      ).toEqual(terminalResponseFailure(html))
    },
  )

  test.each([ACCESS_DENIED, VERIFICATION_REQUIRED, CLOUDFLARE_ORIGIN_ERROR])(
    "an authoritative challenge header takes precedence over terminal-looking markup",
    async (html) => {
      const headers = { "CF-Mitigated": "Challenge" }
      expect(terminalResponseFailure(html, headers)).toBeUndefined()
      expect(isCloudflarePage(html, headers)).toBe(true)
      expect(detectChallengeType(html, headers, 503)).toBe("cloudflare-interstitial")
      let waited = false
      const cloudflare = async () => {
        waited = true
        return "ok" as const
      }
      const result = await routeChallengeWait({} as never, html, headers, 1000, undefined, { cloudflare } as never, 503)
      expect(result).toEqual({ challengeType: "cloudflare-interstitial", resolution: "ok" })
      expect(waited).toBe(true)
    },
  )

  test.each([ACCESS_DENIED, VERIFICATION_REQUIRED, CLOUDFLARE_ORIGIN_ERROR])(
    "does not attempt local or external challenge solving for a terminal response",
    async (html) => {
      const unexpected = async () => {
        throw new Error("terminal responses must not start a solver")
      }
      const result = await routeChallengeWait(
        {} as never,
        html,
        {},
        1000,
        undefined,
        {
          cloudflare: unexpected,
          ddosGuard: unexpected,
          imperva: unexpected,
          akamai: unexpected,
          awsWaf: unexpected,
          dataDome: unexpected,
        },
        html === CLOUDFLARE_ORIGIN_ERROR ? 522 : 200,
        undefined,
        undefined,
        { discover: unexpected } as never,
      )
      expect(result).toEqual({ challengeType: "none", resolution: "ok" })
    },
  )

  test.each(ORDINARY_RESPONSE_CONTROLS)("accepts ordinary short pages and quoted examples: %s", (html) => {
    expect(isBlocked(200, html)).toBe(false)
    expect(persistentBrowserWall(html, "https://fixture.example/", {}, 200, "none")).toBeUndefined()
    expect(detectChallengeType(html, {}, 200)).toBe("none")
  })
})

describe("HTTP terminal responses", () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      const originCode = Number(/^\/origin(?:\/(\d+))?$/.exec(path)?.[1] ?? 522)
      return new Response(
        path === "/denied" ? ACCESS_DENIED : path === "/verification" ? VERIFICATION_REQUIRED : originError(originCode),
        {
          status: path.startsWith("/origin") ? originCode : 200,
          headers: { "content-type": "text/html" },
        },
      )
    },
  })
  afterAll(() => server.stop(true))

  test.each(ORIGIN_ERROR_CODES)(
    "the public HTTP scrape reports origin HTTP %i without acquiring a browser or spending proxy fallback",
    async (code) => {
      let acquired = 0
      const residentialProxyPool = new ProxyPool(["http://residential.invalid:8080"])
      const deps: OrchestratorDeps = {
        minTier: 1,
        residentialProxyPool,
        acquireBrowser: async () => {
          acquired++
          throw new Error("an origin error must not acquire a browser")
        },
        releaseBrowser() {},
        loadSession: async () => undefined,
        saveSession: async () => {},
        invalidateSession: async () => {},
      }
      let caught: unknown
      try {
        await scrape({ url: `${server.url}origin/${code}`, maxTier: 4, maxTimeout: 3000 }, deps)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ScrapeError)
      expect((caught as ScrapeError).message).toBe(`cloudflare-origin-http-${code}`)
      expect((caught as ScrapeError).timings).toMatchObject([
        { tier: 1, status: "error", reason: `cloudflare-origin-http-${code}` },
      ])
      expect(acquired).toBe(0)
      expect(residentialProxyPool.hasAvailable()).toBe(true)
    },
  )

  test.each(["denied", "verification"])("an HTTP %s wall still permits browser recovery", async (path) => {
    let acquired = 0
    let browserRuns = 0
    const result = await scrape(
      { url: `${server.url}${path}`, maxTier: 3, maxTimeout: 3000 },
      {
        minTier: 1,
        acquireBrowser: async () => {
          acquired++
          return {} as never
        },
        releaseBrowser() {},
        loadSession: async () => undefined,
        saveSession: async () => {},
        invalidateSession: async () => {},
      },
      {
        tier3: async () => {
          browserRuns++
          return { tier: 3, status: "success", durationMs: 1, html: "<html><body>Recovered content</body></html>" }
        },
      },
    )
    expect(result.html).toContain("Recovered content")
    expect(result.timings.map((attempt) => attempt.status)).toEqual(["blocked", "success"])
    expect(acquired).toBe(1)
    expect(browserRuns).toBe(1)
  })

  test.each([
    ["denied", "blocked", "akamai-access-denied"],
    ["verification", "blocked", "automated-access-verification-required"],
    ["origin", "error", "cloudflare-origin-http-522"],
  ] as const)("classifies %s at the real HTTP seam", async (path, status, reason) => {
    const result = await runTier1(`${server.url}${path}`)
    expect(result.status).toBe(status)
    expect(result.reason).toBe(reason)
  })
})
