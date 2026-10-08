import { expect, test } from "bun:test"
import { scrape } from "../src/orchestrator"
import { normalizeInputCookies } from "../src/utils/cookies"

test("cookie import normalizes FlareSolverr expiry and rejects malformed or oversized input", () => {
  expect(
    normalizeInputCookies([{ name: "login", value: "fixture", expiry: -1 }], "https://example.com/account")[0],
  ).toMatchObject({ domain: "example.com", path: "/", expires: -1 })
  for (const cookies of [
    null,
    {},
    [null],
    [{ name: "a", value: 1 }],
    [{ name: "a", value: "b", sameSite: "invalid" }],
    [{ name: "a", value: "b", expires: -2 }],
    [{ name: "a", value: "b", path: "other" }],
    [{ name: "a", value: "x".repeat(1_000_001) }],
  ]) {
    expect(() => normalizeInputCookies(cookies as never, "https://example.com")).toThrow()
  }
})

test("imported login cookies skip HTTP and the shared cache, and never enter clearance storage", async () => {
  const cookies = [{ name: "login", value: "fixture" }]
  const result = await scrape(
    { url: "https://example.com", cookies },
    {
      acquireBrowser: async () => ({ id: 0, browser: {}, context: {}, fingerprint: { userAgent: "fixture" } }) as never,
      releaseBrowser: () => {},
      loadSession: async () => {
        throw new Error("must not load clearance cache")
      },
      saveSession: async () => {
        throw new Error("must not publish login cookies")
      },
      invalidateSession: async () => {},
    },
    {
      tier1: async () => {
        throw new Error("must use browser")
      },
      tier3: async (_url, _handle, _ms, _proxy, _headers, _method, _body, _validator, _shot, capture) => {
        expect(capture?.cookies).toEqual(cookies)
        return {
          tier: 3,
          status: "success",
          durationMs: 1,
          html: "<html>Account</html>",
          cookies: [{ ...cookies[0], domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true }],
        }
      },
    },
  )
  expect(result.tier).toBe(3)
})
