import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { applyDataDomeToken, fetchDataDomeToken } from "../src/solvers/datadomeToken"

function fakePage(response: { status: number; body: unknown } | "timeout" | "network-error") {
  const requests: Array<{ url: string; data: string; headers: Record<string, string> }> = []
  const cookies: Array<{ name: string; value: string; domain: string }> = []

  const page = {
    request: {
      post: async (url: string, options: { data: string; headers: Record<string, string>; timeout?: number }) => {
        requests.push({ url, data: options.data, headers: options.headers })
        if (response === "timeout") throw new Error("timeout")
        if (response === "network-error") throw new Error("net::ERR_CONNECTION_REFUSED")
        return {
          ok: () => response.status >= 200 && response.status < 300,
          status: () => response.status,
          json: async () => response.body,
        }
      },
    },
    context: () => ({
      addCookies: async (c: typeof cookies) => {
        cookies.push(...c)
      },
    }),
  } as unknown as Page

  return { page, requests, cookies }
}

describe("fetchDataDomeToken", () => {
  const DDK = "ABC123DEF456"
  const ORIGIN = "https://www.example.com"
  const CAPTCHA_URL = "https://geo.captcha-delivery.com/captcha/?cid=test-cid-12345"

  test("extracts cid from captcha URL and posts fingerprint to DataDome", async () => {
    const { page, requests } = fakePage({ status: 200, body: { cookie: "datadome=abcdef123456; Path=/; Secure" } })

    const result = await fetchDataDomeToken(page, { captchaUrl: CAPTCHA_URL, ddk: DDK, origin: ORIGIN })

    expect(result.cookie).toBe("abcdef123456")
    expect(result.error).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("https://api-js.datadome.co/js/")

    const params = new URLSearchParams(requests[0].data)
    expect(params.get("cid")).toBe("test-cid-12345")
    expect(params.get("ddk")).toBe(DDK)
    expect(params.get("responsePage")).toBe("origin")
    expect(JSON.parse(params.get("jsData")!)).toHaveProperty("ua")
    expect(JSON.parse(params.get("events")!)).toBeArray()
    expect(JSON.parse(params.get("eventCounters")!)).toHaveProperty("mouse_move")
  })

  test("accepts cid directly instead of captcha URL", async () => {
    const { page, requests } = fakePage({ status: 200, body: { cookie: "datadome=xyz789; Path=/" } })

    const result = await fetchDataDomeToken(page, { cid: "direct-cid", ddk: DDK, origin: ORIGIN })

    expect(result.cookie).toBe("xyz789")
    const params = new URLSearchParams(requests[0].data)
    expect(params.get("cid")).toBe("direct-cid")
  })

  test("returns error when no cid is available", async () => {
    const { page, requests } = fakePage({ status: 200, body: {} })

    const result = await fetchDataDomeToken(page, { ddk: DDK, origin: ORIGIN })

    expect(result.error).toBe("no cid")
    expect(result.cookie).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  test("returns error on HTTP failure", async () => {
    const { page } = fakePage({ status: 403, body: {} })

    const result = await fetchDataDomeToken(page, { captchaUrl: CAPTCHA_URL, ddk: DDK, origin: ORIGIN })

    expect(result.error).toBe("http 403")
    expect(result.cookie).toBeUndefined()
  })

  test("returns error when response has no cookie", async () => {
    const { page } = fakePage({ status: 200, body: { url: "https://example.com" } })

    const result = await fetchDataDomeToken(page, { captchaUrl: CAPTCHA_URL, ddk: DDK, origin: ORIGIN })

    expect(result.error).toBe("no cookie in response")
  })

  test("returns error on malformed cookie", async () => {
    const { page } = fakePage({ status: 200, body: { cookie: "something-without-datadome-prefix" } })

    const result = await fetchDataDomeToken(page, { captchaUrl: CAPTCHA_URL, ddk: DDK, origin: ORIGIN })

    expect(result.error).toBe("malformed cookie")
  })

  test("returns error on network timeout", async () => {
    const { page } = fakePage("timeout")

    const result = await fetchDataDomeToken(page, { captchaUrl: CAPTCHA_URL, ddk: DDK, origin: ORIGIN })

    expect(result.error).toBe("timeout")
  })

  test("returns error on network failure", async () => {
    const { page } = fakePage("network-error")

    const result = await fetchDataDomeToken(page, { captchaUrl: CAPTCHA_URL, ddk: DDK, origin: ORIGIN })

    expect(result.error).toBe("net::ERR_CONNECTION_REFUSED")
  })

  test("sends correct headers", async () => {
    const { page, requests } = fakePage({ status: 200, body: { cookie: "datadome=abc; Path=/" } })

    await fetchDataDomeToken(page, {
      captchaUrl: CAPTCHA_URL,
      ddk: DDK,
      origin: ORIGIN,
      referer: "https://www.example.com/checkout",
    })

    expect(requests[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
    expect(requests[0].headers["Origin"]).toBe(ORIGIN)
    expect(requests[0].headers["Referer"]).toBe("https://www.example.com/checkout")
  })

  test("uses deterministic random for reproducible fingerprints", async () => {
    const { page, requests } = fakePage({ status: 200, body: { cookie: "datadome=abc; Path=/" } })
    let seed = 0.5
    const fakeRandom = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }

    await fetchDataDomeToken(page, { captchaUrl: CAPTCHA_URL, ddk: DDK, origin: ORIGIN }, fakeRandom)

    const jsData = JSON.parse(new URLSearchParams(requests[0].data).get("jsData")!)
    expect(jsData.rs_w).toBeNumber()
    expect(jsData.rs_h).toBeNumber()
    expect(jsData.mm_md).toBeNumber()
  })
})

describe("applyDataDomeToken", () => {
  test("sets the datadome cookie on the page context", async () => {
    const { page, cookies } = fakePage({ status: 200, body: {} })

    await applyDataDomeToken(page, "my-token-value", ".example.com")

    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toEqual({
      name: "datadome",
      value: "my-token-value",
      domain: ".example.com",
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    })
  })
})
