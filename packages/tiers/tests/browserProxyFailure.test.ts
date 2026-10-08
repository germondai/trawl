import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"

function handleWithNavigationError(message: string): BrowserHandle {
  const page = {
    route: async () => {},
    on: () => {},
    mainFrame: () => ({}),
    goto: async () => {
      throw new Error(message)
    },
  }
  const context = {
    addInitScript: async () => {},
    newPage: async () => page,
    cookies: async () => [],
    close: async () => {},
  }
  return {
    id: 1,
    lease: 1,
    headful: false,
    context: context as BrowserHandle["context"],
    browser: { newContext: async () => context } as BrowserHandle["browser"],
    fingerprint: { userAgent: "test", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
  }
}

function handleWithBrowserErrorPage(): BrowserHandle {
  const context = {
    addInitScript: async () => {},
    cookies: async () => [],
    close: async () => {},
    newPage: async () => page,
  }
  const page = {
    route: async () => {},
    on: () => {},
    mainFrame: () => page,
    goto: async () => undefined,
    content: async () =>
      '<html><head><title data-l10n-id="neterror-page-title">Problem loading page</title></head><body>proxy failed</body></html>',
    title: async () => "Problem loading page",
    url: () => "about:neterror?e=proxyConnectFailure",
    frames: () => [],
    waitForLoadState: async () => {},
    context: () => context,
  }
  return {
    id: 1,
    lease: 1,
    headful: false,
    context: context as BrowserHandle["context"],
    browser: { newContext: async () => context } as BrowserHandle["browser"],
    fingerprint: { userAgent: "test", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
  }
}

describe("browser proxy network failures", () => {
  test("normalizes Chromium proxy failures in Tier 3", async () => {
    const result = await runTier3(
      "https://target.example",
      handleWithNavigationError("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED"),
      1_000,
      "http://proxy.example:8080",
    )
    expect(result.status).toBe("error")
    expect(result.reason).toBe("proxy-connection-failed")
  })

  test("normalizes Firefox proxy failures in Tier 3", async () => {
    const result = await runTier3(
      "https://target.example",
      handleWithNavigationError("NS_ERROR_PROXY_CONNECTION_REFUSED"),
      1_000,
      "http://proxy.example:8080",
    )
    expect(result.status).toBe("error")
    expect(result.reason).toBe("proxy-connection-failed")
  })

  test("normalizes Firefox proxy failures in Tier 4", async () => {
    const result = await runTier4(
      "https://target.example",
      handleWithNavigationError("NS_ERROR_PROXY_BAD_GATEWAY"),
      1_000,
      "socks5://proxy.example:1080",
    )
    expect(result.status).toBe("error")
    expect(result.reason).toBe("proxy-connection-failed")
  })

  test("retains origin network errors when Tier 3 is direct", async () => {
    const result = await runTier3(
      "https://target.example",
      handleWithNavigationError("page.goto: net::ERR_CONNECTION_REFUSED"),
      1_000,
    )
    expect(result.status).toBe("error")
    expect(result.reason).toContain("ERR_CONNECTION_REFUSED")
  })

  test("Tier 3 never returns Firefox's proxy error page as successful content", async () => {
    const result = await runTier3(
      "https://target.example",
      handleWithBrowserErrorPage(),
      1_500,
      "http://proxy.example:8080",
    )
    expect(result.status).toBe("error")
    expect(result.reason).toBe("proxy-connection-failed")
    expect(result.html).toBeUndefined()
  })

  test("Tier 4 never returns Firefox's proxy error page as successful content", async () => {
    const result = await runTier4(
      "https://target.example",
      handleWithBrowserErrorPage(),
      1_500,
      "http://proxy.example:8080",
    )
    expect(result.status).toBe("error")
    expect(result.reason).toBe("proxy-connection-failed")
    expect(result.html).toBeUndefined()
  })
})
