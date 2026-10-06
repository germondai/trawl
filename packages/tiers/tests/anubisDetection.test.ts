import { afterAll, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { runTier1 } from "../src/tiers/1"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"
import { detectChallengeType, isBlocked, isChallengeWall, isCloudflarePage, needsJs } from "../src/utils/detect"
import { ANUBIS_ARTICLE, ANUBIS_CHALLENGE } from "./fixtures/anubis"

const origin = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return new Response(new URL(request.url).pathname === "/article" ? ANUBIS_ARTICLE : ANUBIS_CHALLENGE, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  },
})
afterAll(() => origin.stop(true))

describe("Anubis challenge detection", () => {
  test.each(["fast", "slow", "metarefresh"])("recognizes an active %s challenge at HTTP 200", (algorithm) => {
    const html = ANUBIS_CHALLENGE.replace('"fast"', JSON.stringify(algorithm))
    const type = detectChallengeType(html)
    expect(type).toBe("anubis")
    expect(isChallengeWall(200, html.length, type, html)).toBe(true)
    expect(needsJs(html, {})).toBe(true)
    expect(isBlocked(200, html)).toBe(true)
  })

  test("does not confuse an Anubis checking title with Cloudflare", () => {
    const html = ANUBIS_CHALLENGE.replace("Making sure you're not a bot!", "Checking your browser")
    expect(isCloudflarePage(html, {})).toBe(false)
    expect(detectChallengeType(html)).toBe("anubis")
  })
  test("preserves authoritative Cloudflare header handling", () => {
    expect(detectChallengeType(ANUBIS_CHALLENGE, { "cf-mitigated": "challenge" })).toBe("cloudflare-interstitial")
  })

  test.each([
    ANUBIS_ARTICLE,
    '<script id="anubis_version" type="application/json">"v1.27.0"</script><p>Normal content</p>',
    `<template>${ANUBIS_CHALLENGE}</template>`,
    `<noscript>${ANUBIS_CHALLENGE}</noscript>`,
    '<script id="anubis_challenge" type="application/json">not JSON</script>',
  ])("does not classify ordinary or inactive markup %#", (html) => {
    expect(detectChallengeType(html)).not.toBe("anubis")
    expect(isBlocked(200, html)).toBe(false)
  })

  test.each([
    ANUBIS_CHALLENGE.replace('"rules":{"algorithm":"fast","difficulty":1}', '"rules":{}'),
    ANUBIS_CHALLENGE.replace('"id":"fixture-challenge"', '"id":""'),
    ANUBIS_CHALLENGE.replace('"randomData":"fixture-data"', '"randomData":null'),
  ])("keeps a broken envelope with the real bootstrap blocked %#", (html) => {
    expect(detectChallengeType(html)).toBe("anubis")
    expect(isBlocked(200, html)).toBe(true)
  })

  test("Tier 1 escalates an HTTP 200 challenge", async () => {
    const result = await runTier1(origin.url.href)
    expect(result.status).toBe("needs-js")
    expect(result.reason).toBe("anubis-challenge")
    expect(result.challenge).toBe("anubis")
    expect(result.statusCode).toBe(200)
  })
  test("Tier 1 still returns an ordinary article", async () => {
    const result = await runTier1(new URL("/article", origin.url).href)
    expect(result.status).toBe("success")
    expect(result.html).toContain("Anubis documentation")
  })

  for (const tier of [2, 3, 4] as const) {
    test.each(
      tier === 2
        ? (["never-clears", "returns-after-clear"] as const)
        : (["never-clears", "returns-after-clear", "short-destination", "empty-after-clear"] as const),
    )(`Tier ${tier} rejects %s challenges`, async (scenario) => {
      let reads = 0
      let contextClosed = false
      const budget = scenario === "never-clears" ? 100 : 2000
      const page = {
        url: () => "https://fixture.test/",
        title: async () => "Making sure you're not a bot!",
        content: async () => {
          reads++
          return scenario === "never-clears" ||
            reads === 1 ||
            (scenario === "returns-after-clear" && reads >= (tier === 2 ? 5 : 4))
            ? ANUBIS_CHALLENGE
            : scenario === "short-destination"
              ? "<html>OK</html>"
              : scenario === "empty-after-clear" && reads >= 4
                ? "<html><body></body></html>"
                : ANUBIS_ARTICLE
        },
        goto: async () => {},
        on: () => {},
        frames: () => [],
        context: () => ({ cookies: async () => [] }),
        waitForLoadState: async () => {},
        setExtraHTTPHeaders: async () => {},
        evaluate: async () => "test-agent",
        close: async () => {},
      }
      const context = {
        newPage: async () => page,
        addCookies: async () => {},
        addInitScript: async () => {},
        cookies: async () => [],
        close: async () => {
          contextClosed = true
        },
      }
      const handle: BrowserHandle = {
        id: 1,
        lease: 1,
        context,
        browser: { newContext: async () => context },
        fingerprint: { userAgent: "test-agent", platform: "Linux", locale: "en-US", timezone: "UTC" },
      }
      const result =
        tier === 2
          ? await runTier2(
              "https://fixture.test/",
              handle,
              { cookies: [], userAgent: "test-agent", savedAt: 1 },
              budget,
            )
          : tier === 3
            ? await runTier3("https://fixture.test/", handle, budget)
            : await runTier4("https://fixture.test/", handle, budget, "http://proxy.test:8080")
      expect(result.status).toBe(
        scenario === "short-destination"
          ? "success"
          : tier === 2 || scenario !== "never-clears"
            ? "blocked"
            : "timeout",
      )
      expect(result.reason).toBe(
        scenario === "short-destination"
          ? undefined
          : tier === 2
            ? "anubis-session-expired"
            : scenario === "never-clears"
              ? "anubis-challenge-timeout"
              : "anubis-persistent",
      )
      expect(contextClosed).toBe(tier !== 2)
    })
  }
})
