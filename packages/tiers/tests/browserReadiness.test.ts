import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"

const html = `<html><body>${"Ready document ".repeat(20)}</body></html>`

function fixture() {
  const waits: string[] = []
  let closed = 0
  const page = {
    route: async () => {},
    on: () => {},
    setExtraHTTPHeaders: async () => {},
    mainFrame: () => page,
    goto: async () => undefined,
    content: async () => html,
    title: async () => "Fixture",
    context: () => context,
    close: async () => {
      closed++
    },
    url: () => "https://fixture.example/",
    frames: () => [],
    evaluate: async () => "fixture-agent",
    waitForSelector: async () => ({}),
    waitForLoadState: async (state: string) => {
      waits.push(state)
      if (state === "networkidle") await Bun.sleep(600)
    },
  }
  const context = {
    addInitScript: async () => {},
    addCookies: async () => {},
    newPage: async () => page,
    cookies: async () => [],
    close: async () => {
      closed++
    },
  }
  const handle: BrowserHandle = {
    id: 1,
    lease: 1,
    headful: false,
    browser: { newContext: async () => context },
    context,
    fingerprint: { userAgent: "fixture-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
  }
  return { handle, waits, closed: () => closed }
}

describe("browser document readiness", () => {
  for (const tier of [2, 3, 4] as const) {
    test(`Tier ${tier} returns ready content without an unrelated settle delay`, async () => {
      const site = fixture()
      const result =
        tier === 2
          ? await runTier2(
              "https://fixture.example/",
              site.handle,
              { cookies: [], userAgent: "fixture-agent", savedAt: 1 },
              900,
              undefined,
              undefined,
              undefined,
              undefined,
              false,
              { contentWaitForSelector: "#ready" },
            )
          : tier === 3
            ? await runTier3(
                "https://fixture.example/",
                site.handle,
                900,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                { contentWaitForSelector: "#ready" },
              )
            : await runTier4(
                "https://fixture.example/",
                site.handle,
                900,
                "http://proxy.example:8080",
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                { contentWaitForSelector: "#ready" },
              )
      expect(result.status).toBe("success")
      expect(result.html).toBe(html)
      expect(site.waits).not.toContain("networkidle")
      expect(site.closed()).toBe(1)
    })
  }
})
