import { describe, expect, test } from "bun:test"
import { type OrchestratorDeps, type ScrapeError, scrape } from "../src/orchestrator"
import { wallOutcomes, widgetOutcomes } from "../src/utils/captchaOutcomes"
import { ProxyPool } from "../src/utils/proxyRotator"

describe("CAPTCHA outcomes", () => {
  test("widgets: every attempted kind is solved or failed", () => {
    expect(widgetOutcomes(["turnstile", "altcha", "turnstile:2captcha"], ["altcha", "turnstile:2captcha"])).toEqual([
      { kind: "turnstile", outcome: "failed" },
      { kind: "altcha", outcome: "solved" },
      { kind: "turnstile:2captcha", outcome: "solved" },
    ])
    expect(widgetOutcomes([], [])).toEqual([])
  })

  test("walls: a CAPTCHA no solver cleared is a failure of the wall's own kind", () => {
    expect(wallOutcomes("aws-waf", "captcha-required")).toEqual([{ kind: "aws-waf", outcome: "failed" }])
    expect(wallOutcomes("datadome", "captcha-required", [])).toEqual([{ kind: "datadome", outcome: "failed" }])
  })

  test("walls: a solved wall reports only what was solved", () => {
    expect(wallOutcomes("aws-waf", "ok", ["aws-waf"])).toEqual([{ kind: "aws-waf", outcome: "solved" }])
    expect(wallOutcomes("aws-waf", "captcha-required", ["aws-waf"])).toEqual([{ kind: "aws-waf", outcome: "solved" }])
  })

  test("walls: timeouts and plain blocks are not CAPTCHA attempts", () => {
    for (const resolution of ["timeout", "blocked", "ip-blocked", "browser-closed", "ok"]) {
      expect(wallOutcomes("cloudflare", resolution)).toEqual([])
    }
  })
})

const payload = {
  html: "<html><body>Destination</body></html>",
  effectiveUrl: "https://example.test/final",
  body: new Uint8Array([1]),
  responseHeaders: {},
  contentType: "text/html",
  statusCode: 200,
}

const deps = (): OrchestratorDeps => ({
  minTier: 3 as const,
  acquireBrowser: async () => ({
    id: 1,
    lease: 1,
    headful: false,
    context: {},
    browser: {},
    fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
  }),
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
  residentialProxyPool: new ProxyPool(["http://residential.test:8080"]),
})

describe("CAPTCHA outcomes through the orchestrator", () => {
  test("a tier's CAPTCHAs land on its own attempt in timings", async () => {
    const result = await scrape({ url: "https://example.test/", skipHttp: true }, deps(), {
      tier3: async (_url, _handle, _timeout, _proxy, _headers, _method, _body, _validate, _shot, capture) => {
        capture?.captchaOutcomes?.([
          { kind: "altcha", outcome: "solved" },
          { kind: "shumei", outcome: "failed" },
        ])
        return { ...payload, tier: 3 as const, status: "success" as const, durationMs: 4 }
      },
    })
    expect(result.timings.at(-1)).toMatchObject({
      tier: 3,
      status: "success",
      captchas: [
        { kind: "altcha", outcome: "solved" },
        { kind: "shumei", outcome: "failed" },
      ],
    })
  })

  test("attempts that tried no CAPTCHA carry no captchas field", async () => {
    const result = await scrape({ url: "https://example.test/", skipHttp: true }, deps(), {
      tier3: async () => ({ ...payload, tier: 3 as const, status: "success" as const, durationMs: 4 }),
    })
    expect(result.timings.at(-1)).not.toHaveProperty("captchas")
  })

  test("CAPTCHAs of a failed tier do not leak onto the next attempt", async () => {
    let calls = 0
    const result = await scrape({ url: "https://example.test/", skipHttp: true, maxTier: 4 }, deps(), {
      tier3: async (_url, _handle, _timeout, _proxy, _headers, _method, _body, _validate, _shot, capture) => {
        if (calls++ === 0) capture?.captchaOutcomes?.([{ kind: "aws-waf", outcome: "failed" }])
        return {
          ...payload,
          tier: 3 as const,
          status: "blocked" as const,
          durationMs: 4,
          reason: "aws-waf-captcha-required",
        }
      },
      tier4: async () => ({ ...payload, tier: 4 as const, status: "success" as const, durationMs: 4 }),
    }).catch((error: ScrapeError) => ({ timings: error.timings }))
    const withCaptchas = result.timings.filter((attempt) => attempt.captchas)
    expect(withCaptchas).toHaveLength(1)
    expect(withCaptchas[0]).toMatchObject({ tier: 3, captchas: [{ kind: "aws-waf", outcome: "failed" }] })
  })
})
