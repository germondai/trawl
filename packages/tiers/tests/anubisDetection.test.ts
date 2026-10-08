import { describe, expect, test } from "bun:test"
import { parseHTML } from "linkedom"
import type { Page } from "patchright"
import { runTier1 } from "../src/tiers/1"
import { waitForAnubisResolution } from "../src/utils/anubisWait"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import {
  detectChallengeType,
  hasAnubisChallenge,
  isBlocked,
  isChallengeWall,
  isCloudflarePage,
  needsJs,
} from "../src/utils/detect"
import { ANUBIS_CHALLENGE, ANUBIS_DOCS_PAGE, ANUBIS_POW_CHALLENGE } from "./fixtures/anubis"
import { withFetch } from "./helpers/fetch"

const htmlResponse = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } })

describe("Anubis PoW challenge detection", () => {
  test("classifies the real challenge page served at HTTP 200 as a wall", () => {
    for (const html of [ANUBIS_CHALLENGE, ANUBIS_POW_CHALLENGE]) {
      expect(hasAnubisChallenge(html)).toBe(true)
      expect(detectChallengeType(html)).toBe("anubis")
      expect(isCloudflarePage(html, {})).toBe(false)
      expect(needsJs(html, {})).toBe(true)
      expect(isBlocked(200, html)).toBe(true)
      expect(isChallengeWall(200, html.length, "anubis")).toBe(true)
    }
  })

  test("does not classify documentation or prose mentions of Anubis", () => {
    for (const html of [
      ANUBIS_DOCS_PAGE,
      "<p>Anubis weighs the soul of incoming HTTP requests with a proof-of-work challenge.</p>",
      '<a href="https://anubis.techaro.lol/docs">Anubis documentation</a>',
    ]) {
      expect(hasAnubisChallenge(html)).toBe(false)
      expect(detectChallengeType(html)).toBe("none")
      expect(needsJs(html, {})).toBe(false)
      expect(isBlocked(200, html)).toBe(false)
    }
  })

  test("Tier 1 escalates the challenge page to needs-js instead of returning it as success", async () => {
    await withFetch(htmlResponse(ANUBIS_CHALLENGE, 200), async () => {
      const result = await runTier1("https://anubis.techaro.lol/")
      expect(result.status).toBe("needs-js")
      expect(result.reason).toBe("anubis-challenge")
      expect(result.challenge).toBe("anubis")
      expect(result.statusCode).toBe(200)
    })
  })

  test("routes the challenge to its dedicated resolver without invoking the WAF waiters", async () => {
    const fail = async () => {
      throw new Error("waiter must not run")
    }
    const clearedPage = {
      content: async () => "<html><body>real content</body></html>",
      evaluate: async (read: (document: Document) => unknown) =>
        read(parseHTML("<html><body>real content</body></html>").document),
      isClosed: () => false,
      url: () => "https://example.test/article",
    } as unknown as Page
    const result = await routeChallengeWait(clearedPage, ANUBIS_CHALLENGE, {}, 1000, undefined, {
      cloudflare: fail,
      ddosGuard: fail,
      imperva: fail,
      akamai: fail,
      awsWaf: fail,
      dataDome: fail,
    })
    expect(result).toEqual({ challengeType: "anubis", resolution: "ok" })
  })

  test("resolver waits for Anubis's own JS to clear the markers", async () => {
    const pages = [ANUBIS_CHALLENGE, ANUBIS_CHALLENGE, "<html><body>real content</body></html>"]
    const page = {
      evaluate: async (read: (document: Document) => unknown) =>
        read(parseHTML(pages.shift() ?? "<html><body>real content</body></html>").document),
      isClosed: () => false,
      url: () => "https://example.test/article",
    } as unknown as Page
    expect(await waitForAnubisResolution(page, 5000)).toBe("ok")
  })

  test("resolver times out while the challenge persists", async () => {
    const page = {
      evaluate: async () => ({ state: "challenge" }),
      isClosed: () => false,
      url: () => "https://example.test/",
    } as unknown as Page
    expect(await waitForAnubisResolution(page, 50)).toBe("timeout")
  })
})
