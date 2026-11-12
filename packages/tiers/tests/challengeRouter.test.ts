import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import type { ExternalCaptchaSession } from "../src/solvers/externalCaptcha"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { DATADOME_CAPTCHA, DATADOME_INTERSTITIAL, DATADOME_JSON_HARD_BLOCK } from "./fixtures/datadome"
import { DDOS_GUARD_INTERSTITIAL } from "./fixtures/ddosGuard"
import { DUCKDUCKGO_ANOMALY_CHALLENGE } from "./fixtures/duckduckgo"
import { ALTCHA_WIDGET_HTML, FRIENDLY_CAPTCHA_WIDGET_HTML } from "./fixtures/pow"

describe("browser challenge routing", () => {
  test("passes response headers into detection and routes an authoritative CF challenge to its waiter", async () => {
    const calls: string[] = []
    const waiter = (name: string) => async () => {
      calls.push(name)
      return "ok" as const
    }
    const result = await routeChallengeWait(
      {} as Page,
      DDOS_GUARD_INTERSTITIAL,
      { "cf-mitigated": "challenge" },
      100,
      "https://example.test/",
      {
        cloudflare: waiter("cloudflare"),
        ddosGuard: waiter("ddos-guard"),
        imperva: waiter("imperva"),
        akamai: waiter("akamai"),
        awsWaf: waiter("aws-waf"),
        dataDome: waiter("datadome"),
      },
    )

    expect(result.challengeType).toBe("cloudflare-interstitial")
    expect(calls).toEqual(["cloudflare"])
  })

  test("routes DDoS-Guard markers to the dedicated waiter without the CF header", async () => {
    const calls: string[] = []
    const waiter = (name: string) => async () => {
      calls.push(name)
      return "ok" as const
    }
    const result = await routeChallengeWait({} as Page, DDOS_GUARD_INTERSTITIAL, {}, 100, undefined, {
      cloudflare: waiter("cloudflare"),
      ddosGuard: waiter("ddos-guard"),
      imperva: waiter("imperva"),
      akamai: waiter("akamai"),
      awsWaf: waiter("aws-waf"),
      dataDome: waiter("datadome"),
    })

    expect(result.challengeType).toBe("ddos-guard")
    expect(calls).toEqual(["ddos-guard"])
  })

  test("routes AWS WAF to its dedicated waiter", async () => {
    const calls: string[] = []
    const waiter = (name: string) => async () => {
      calls.push(name)
      return "ok" as const
    }
    const result = await routeChallengeWait(
      {} as Page,
      "",
      { "X-Amzn-Waf-Action": "Challenge" },
      100,
      "https://example.test/",
      {
        cloudflare: waiter("cloudflare"),
        ddosGuard: waiter("ddos-guard"),
        imperva: waiter("imperva"),
        akamai: waiter("akamai"),
        awsWaf: waiter("aws-waf"),
        dataDome: waiter("datadome"),
      },
      202,
    )

    expect(result).toEqual({ challengeType: "aws-waf", resolution: "ok" })
    expect(calls).toEqual(["aws-waf"])
  })

  test("returns CAPTCHA-required without invoking a waiter", async () => {
    const fail = async () => {
      throw new Error("waiter must not run")
    }
    const result = await routeChallengeWait(
      {} as Page,
      "",
      { "x-amzn-waf-action": "captcha" },
      100,
      undefined,
      { cloudflare: fail, ddosGuard: fail, imperva: fail, akamai: fail, awsWaf: fail, dataDome: fail },
      405,
    )
    expect(result).toEqual({ challengeType: "aws-waf", resolution: "captcha-required" })
  })

  describe("AWS WAF CAPTCHA wall solving", () => {
    const wall = { "x-amzn-waf-action": "captcha" }
    const reloaded = { content: async () => "<html><body>real page</body></html>" } as unknown as Page
    const idle = async () => {
      throw new Error("waiter must not run")
    }
    const waiters = (overrides: Record<string, unknown>) =>
      ({
        cloudflare: idle,
        ddosGuard: idle,
        imperva: idle,
        akamai: idle,
        awsWaf: idle,
        dataDome: idle,
        ...overrides,
      }) as never

    test("solves the wall, then lets the waiter confirm the new token", async () => {
      const calls: string[] = []
      const result = await routeChallengeWait(
        reloaded,
        "",
        wall,
        1000,
        "https://example.test/",
        waiters({
          awsWafCaptcha: async () => {
            calls.push("solve")
            return true
          },
          awsWaf: async () => {
            calls.push("confirm")
            return "ok" as const
          },
        }),
        405,
      )
      expect(calls).toEqual(["solve", "confirm"])
      expect(result).toEqual({ challengeType: "aws-waf", resolution: "ok", captchasSolved: ["aws-waf"] })
    })

    test("keeps CAPTCHA-required when the solver fails and never runs the waiter", async () => {
      const result = await routeChallengeWait(
        reloaded,
        "",
        wall,
        1000,
        undefined,
        waiters({ awsWafCaptcha: async () => false }),
        405,
      )
      expect(result).toEqual({ challengeType: "aws-waf", resolution: "captcha-required" })
    })

    test("keeps CAPTCHA-required when the solver throws", async () => {
      const result = await routeChallengeWait(
        reloaded,
        "",
        wall,
        1000,
        undefined,
        waiters({
          awsWafCaptcha: async () => {
            throw new Error("browser closed")
          },
        }),
        405,
      )
      expect(result).toEqual({ challengeType: "aws-waf", resolution: "captcha-required" })
    })

    test("reports the waiter verdict, without claiming a solve, when the token is not accepted", async () => {
      const result = await routeChallengeWait(
        reloaded,
        "",
        wall,
        1000,
        undefined,
        waiters({ awsWafCaptcha: async () => true, awsWaf: async () => "ip-blocked" as const }),
        405,
      )
      expect(result).toEqual({ challengeType: "aws-waf", resolution: "ip-blocked" })
    })

    test("does not try to solve once the request is aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await routeChallengeWait(
        reloaded,
        "",
        wall,
        1000,
        undefined,
        waiters({ awsWafCaptcha: idle }),
        405,
        undefined,
        undefined,
        undefined,
        undefined,
        controller.signal,
      )
      expect(result).toEqual({ challengeType: "aws-waf", resolution: "captcha-required" })
    })
  })

  test("reports a DuckDuckGo image challenge without invoking the Cloudflare waiter", async () => {
    const fail = async () => {
      throw new Error("waiter must not run")
    }
    const result = await routeChallengeWait(
      {} as Page,
      DUCKDUCKGO_ANOMALY_CHALLENGE,
      {},
      100,
      undefined,
      { cloudflare: fail, ddosGuard: fail, imperva: fail, akamai: fail, awsWaf: fail, dataDome: fail },
      202,
    )
    expect(result).toEqual({ challengeType: "duckduckgo", resolution: "captcha-required" })
  })

  test("routes the DataDome Device Check to its dedicated waiter", async () => {
    const calls: string[] = []
    const waiter = (name: string) => async () => {
      calls.push(name)
      return "ok" as const
    }
    const result = await routeChallengeWait(
      {} as Page,
      DATADOME_INTERSTITIAL,
      {},
      100,
      "https://example.test/",
      {
        cloudflare: waiter("cloudflare"),
        ddosGuard: waiter("ddos-guard"),
        imperva: waiter("imperva"),
        akamai: waiter("akamai"),
        awsWaf: waiter("aws-waf"),
        dataDome: waiter("datadome"),
      },
      403,
    )

    expect(result).toEqual({ challengeType: "datadome", resolution: "ok" })
    expect(calls).toEqual(["datadome"])
  })

  test("returns the DataDome slider and hard block without invoking a waiter", async () => {
    const fail = async () => {
      throw new Error("waiter must not run")
    }
    const waiters = {
      cloudflare: fail,
      ddosGuard: fail,
      imperva: fail,
      akamai: fail,
      awsWaf: fail,
      dataDome: fail,
    }

    expect(await routeChallengeWait({} as Page, DATADOME_CAPTCHA, {}, 100, undefined, waiters, 403)).toEqual({
      challengeType: "datadome",
      resolution: "captcha-required",
    })
    expect(await routeChallengeWait({} as Page, DATADOME_JSON_HARD_BLOCK, {}, 100, undefined, waiters, 403)).toEqual({
      challengeType: "datadome",
      resolution: "ip-blocked",
    })
  })

  test("lets embedded proof-of-work widgets proceed without invoking a WAF waiter", async () => {
    const fail = async () => {
      throw new Error("waiter must not run")
    }
    const waiters = { cloudflare: fail, ddosGuard: fail, imperva: fail, akamai: fail, awsWaf: fail, dataDome: fail }

    expect(await routeChallengeWait({} as Page, ALTCHA_WIDGET_HTML, {}, 100, undefined, waiters, 200)).toEqual({
      challengeType: "altcha",
      resolution: "ok",
    })
    expect(
      await routeChallengeWait({} as Page, FRIENDLY_CAPTCHA_WIDGET_HTML, {}, 100, undefined, waiters, 200),
    ).toEqual({ challengeType: "friendly-captcha", resolution: "ok" })
  })
})

test("routes embedded Turnstile to its token solver instead of a wall waiter", async () => {
  const fail = async () => {
    throw new Error("wall waiter must not run")
  }
  const html =
    '<html><head><title>Contact us</title></head><body><form><div class="cf-turnstile" data-sitekey="test"></div></form></body></html>'
  const result = await routeChallengeWait(
    {} as Page,
    html,
    {},
    1000,
    undefined,
    { cloudflare: fail, ddosGuard: fail, imperva: fail, akamai: fail, awsWaf: fail, dataDome: fail },
    200,
  )
  expect(result).toEqual({ challengeType: "cloudflare-turnstile", resolution: "ok" })
})

test("keeps Turnstile on an active Cloudflare wall in the wall waiter", async () => {
  let waited = false
  const cf = async () => {
    waited = true
    return "timeout" as const
  }
  const html = '<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>'
  const result = await routeChallengeWait(
    {} as Page,
    html,
    {},
    1000,
    undefined,
    { cloudflare: cf, ddosGuard: cf, imperva: cf, akamai: cf, awsWaf: cf, dataDome: cf },
    403,
  )
  expect(waited).toBe(true)
  expect(result.resolution).toBe("timeout")
})

test("a configured WAF profile must clear the challenge after applying its response", async () => {
  let solves = 0
  let cleared = false
  const external = {
    discover: async () => ["profile:0"],
    canSolve: async () => true,
    localBudget: () => 10,
    solveProfiles: async () => {
      solves++
      return ["datadome:2captcha"]
    },
  } as unknown as ExternalCaptchaSession
  const page = { content: async () => (cleared ? "<html><body>Owned content</body></html>" : DATADOME_CAPTCHA) } as Page
  const waiters = { cloudflare: async () => "ok" as const } as unknown as Parameters<typeof routeChallengeWait>[5]
  const run = () =>
    routeChallengeWait(page, DATADOME_CAPTCHA, {}, 10000, undefined, waiters, 403, undefined, () => ({}), external)
  expect(await run()).toEqual({ challengeType: "datadome", resolution: "captcha-required" })
  cleared = true
  expect(await run()).toEqual({ challengeType: "none", resolution: "ok", captchasSolved: ["datadome:2captcha"] })
  expect(solves).toBe(2)
})

test("DataDome IP blocks do not create paid profile tasks", async () => {
  let solves = 0
  const external = {
    discover: async () => ["profile:0"],
    canSolve: async () => true,
    localBudget: () => 10,
    solveProfiles: async () => {
      solves++
      return ["datadome:2captcha"]
    },
  } as unknown as ExternalCaptchaSession
  expect(
    await routeChallengeWait(
      {} as Page,
      DATADOME_JSON_HARD_BLOCK,
      {},
      10000,
      undefined,
      undefined,
      403,
      undefined,
      () => ({}),
      external,
    ),
  ).toEqual({ challengeType: "datadome", resolution: "ip-blocked" })
  expect(solves).toBe(0)
})

test("a managed Cloudflare render can recover rejected clearance, but not a hard error page", async () => {
  let url = "https://example.test/owned"
  let solves = 0
  let waits = 0
  const external = {
    discover: async () => ["cloudflare-challenge"],
    supports: () => true,
    localBudget: () => 10,
    solveProfiles: async () => {
      solves++
      return ["cloudflare-challenge:2captcha"]
    },
  } as unknown as ExternalCaptchaSession
  const page = { url: () => url, content: async () => "<html><body>Owned content</body></html>" } as Page
  const waiters = { cloudflare: async () => (++waits === 1 ? "ip-blocked" : "ok") } as unknown as Parameters<
    typeof routeChallengeWait
  >[5]
  const run = () =>
    routeChallengeWait(
      page,
      '<form id="challenge-form"></form>',
      { "cf-mitigated": "challenge" },
      10000,
      url,
      waiters,
      403,
      undefined,
      () => ({}),
      external,
    )
  expect(await run()).toEqual({
    challengeType: "none",
    resolution: "ok",
    captchasSolved: ["cloudflare-challenge:2captcha"],
  })
  expect(solves).toBe(1)
  for (const path of ["/cdn-cgi/error/1020", "/?error=1015"]) {
    url = `https://example.test${path}`
    waits = 0
    expect((await run()).resolution).toBe("ip-blocked")
    expect(solves).toBe(1)
  }
})

test("an incomplete managed render retains the unused local wait without reporting a solve", async () => {
  const waits: number[] = []
  const external = {
    discover: async () => ["cloudflare-challenge"],
    supports: () => true,
    localBudget: () => 10,
    solveProfiles: async () => [],
  } as unknown as ExternalCaptchaSession
  const page = { content: async () => '<form id="challenge-form"></form>' } as Page
  const waiters = {
    cloudflare: async (_page: Page, timeout: number) => {
      waits.push(timeout)
      return "timeout"
    },
  } as unknown as Parameters<typeof routeChallengeWait>[5]
  const result = await routeChallengeWait(
    page,
    '<form id="challenge-form"></form>',
    { "cf-mitigated": "challenge" },
    10000,
    undefined,
    waiters,
    undefined,
    undefined,
    () => ({ "cf-mitigated": "challenge" }),
    external,
  )
  expect(result).toEqual({ challengeType: "cloudflare-interstitial", resolution: "timeout" })
  expect(waits).toHaveLength(2)
  expect(waits[0]).toBe(10)
  expect(waits[1]).toBeGreaterThan(9000)
})
