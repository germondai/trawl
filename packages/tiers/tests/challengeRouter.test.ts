import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
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
