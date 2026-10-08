import { afterEach, describe, expect, test } from "bun:test"
import { routeContinueOverrides, runTier1 } from "@trawl/tiers"
import type { FlareSolverrRequest } from "@trawl/types"
import { buildScrapeRequestFromFlareSolverr } from "./flaresolverr"

const PROWLARR_2_5_2_REQUEST: FlareSolverrRequest = {
  cmd: "request.post",
  url: "https://rutracker.org/forum/login.php",
  maxTimeout: 60_000,
  postData: "login_username=example&login_password=secret&login=%D0%92%D1%85%D0%BE%D0%B4",
  headers: {
    contentType: "application/x-www-form-urlencoded",
    contentLength: "82",
  },
}

const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
})

describe("FlareSolverr request adapter", () => {
  test("translates Prowlarr 2.5.2 serialized content metadata", () => {
    const result = buildScrapeRequestFromFlareSolverr(PROWLARR_2_5_2_REQUEST)

    expect(result.method).toBe("POST")
    expect(result.body).toBe(PROWLARR_2_5_2_REQUEST.postData)
    expect(result.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded")
    expect(result.headers?.contentType).toBeUndefined()
    expect(result.headers?.contentLength).toBeUndefined()
  })

  test("recognizes serialized metadata case-insensitively", () => {
    const result = buildScrapeRequestFromFlareSolverr({
      ...PROWLARR_2_5_2_REQUEST,
      headers: { CONTENTTYPE: "application/json", ContentLength: "2" },
    })

    expect(result.headers).toEqual({ "Content-Type": "application/json" })
  })

  test("standard Content-Type takes precedence over Prowlarr metadata", () => {
    const result = buildScrapeRequestFromFlareSolverr({
      ...PROWLARR_2_5_2_REQUEST,
      headers: {
        contentType: "application/x-www-form-urlencoded",
        "content-type": "application/json",
      },
    })

    expect(result.headers).toEqual({ "content-type": "application/json" })
  })

  test("defaults FlareSolverr POST data to form encoding", () => {
    expect(
      buildScrapeRequestFromFlareSolverr({
        cmd: "request.post",
        url: "https://example.com/login",
        postData: "user=a&pw=b",
      }).headers,
    ).toEqual({ "Content-Type": "application/x-www-form-urlencoded" })
  })

  test("passes the normalized body and header through Tier 1 and browser route overrides", async () => {
    const request = buildScrapeRequestFromFlareSolverr(PROWLARR_2_5_2_REQUEST)
    let tier1Init: RequestInit | undefined
    ;(globalThis as { fetch: typeof fetch }).fetch = (async (_input, init) => {
      tier1Init = init
      return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } })
    }) as typeof fetch

    await runTier1(request.url, request.headers, request.method, request.body)
    expect(tier1Init?.method).toBe("POST")
    expect(tier1Init?.body).toBe(PROWLARR_2_5_2_REQUEST.postData)
    expect((tier1Init?.headers as Record<string, string> | undefined)?.["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    )

    const browserOverride = routeContinueOverrides(
      {
        request: () => ({ headers: () => ({ accept: "text/html" }), method: () => "GET" }),
        continue: async () => {},
      },
      request.headers,
      request.method,
      request.body,
    )
    expect(browserOverride.method).toBe("POST")
    expect(browserOverride.postData).toBe(PROWLARR_2_5_2_REQUEST.postData)
    expect(browserOverride.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
  })
})
