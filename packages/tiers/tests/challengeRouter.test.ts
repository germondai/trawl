import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { DATADOME_CAPTCHA, DATADOME_INTERSTITIAL, DATADOME_JSON_HARD_BLOCK } from "./fixtures/datadome"
import { DDOS_GUARD_INTERSTITIAL } from "./fixtures/ddosGuard"

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
    const waiters = { cloudflare: fail, ddosGuard: fail, imperva: fail, akamai: fail, awsWaf: fail, dataDome: fail }

    expect(await routeChallengeWait({} as Page, DATADOME_CAPTCHA, {}, 100, undefined, waiters, 403)).toEqual({
      challengeType: "datadome",
      resolution: "captcha-required",
    })
    expect(await routeChallengeWait({} as Page, DATADOME_JSON_HARD_BLOCK, {}, 100, undefined, waiters, 403)).toEqual({
      challengeType: "datadome",
      resolution: "ip-blocked",
    })
  })
})
