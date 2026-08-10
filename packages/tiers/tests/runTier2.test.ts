import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { SessionData } from "@trawl/types"
import { runTier2 } from "../src/tiers/2"

const session: SessionData = {
  cookies: [
    {
      name: "cf_clearance",
      value: "cached-token",
      domain: ".example.com",
      path: "/",
      expires: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  userAgent: "cached-user-agent",
  savedAt: 1,
}

const handleWithContext = (context: BrowserHandle["context"]): BrowserHandle => ({
  id: 3,
  lease: 7,
  context,
  browser: {},
  fingerprint: {
    userAgent: "pool-user-agent",
    platform: "Linux x86_64",
    locale: "en-US",
    timezone: "UTC",
  },
})

describe("runTier2", () => {
  test("returns an error when the acquired pool context is already closed", async () => {
    const playwrightError = "browserContext.newPage: Target page, context or browser has been closed"
    const handle = handleWithContext({
      newPage: () => Promise.reject(new Error(playwrightError)),
    })

    const result = await runTier2("https://example.com", handle, session, 100)

    expect(result.status).toBe("error")
    expect(result.reason).toBe(playwrightError)
  })

  test("uses the acquired pool context, injects session cookies, and returns content", async () => {
    let injectedCookies: unknown
    let userAgent: Record<string, string> | undefined
    let pageClosed = false
    const page = {
      url: () => "https://example.com/final?ok=1",
      setExtraHTTPHeaders: async (headers: Record<string, string>) => {
        userAgent = headers
      },
      on: () => {},
      goto: async () => {},
      waitForLoadState: async () => {},
      content: async () => "<html><body>pool context content</body></html>",
      close: async () => {
        pageClosed = true
      },
    }
    const context = {
      newPage: async () => page,
      addCookies: async (cookies: unknown) => {
        injectedCookies = cookies
      },
      cookies: async () => session.cookies,
    }

    const result = await runTier2("https://example.com", handleWithContext(context), session, 100)

    expect(result.status).toBe("success")
    expect(result.html).toContain("pool context content")
    expect(result.effectiveUrl).toBe("https://example.com/final?ok=1")
    expect(injectedCookies).toEqual(session.cookies)
    expect(userAgent).toEqual({ "User-Agent": session.userAgent })
    expect(pageClosed).toBe(true)
  })

  test("rejects a cached session that lands on an AWS WAF interstitial", async () => {
    let pageClosed = false
    const page = {
      url: () => "https://example.com/protected",
      setExtraHTTPHeaders: async () => {},
      on: () => {},
      goto: async () => {},
      waitForLoadState: async () => {},
      content: async () =>
        `<script>window.gokuProps={}</script>
         <script src="https://abc.token.awswaf.com/abc/challenge.js"></script>`,
      close: async () => {
        pageClosed = true
      },
    }
    const context = {
      newPage: async () => page,
      addCookies: async () => {},
      cookies: async () => session.cookies,
    }

    const result = await runTier2("https://example.com/protected", handleWithContext(context), session, 100)

    expect(result.status).toBe("blocked")
    expect(result.reason).toBe("aws-waf-session-expired")
    expect(pageClosed).toBe(true)
  })
})
