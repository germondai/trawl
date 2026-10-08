import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { hasAltchaWidget, hasFriendlyCaptchaWidget, solveAltcha, solveFriendlyCaptcha } from "../src/solvers"
import { runTier1 } from "../src/tiers/1"
import {
  detectChallengeType,
  hasAltcha,
  hasFriendlyCaptcha,
  isBlocked,
  isChallengeWall,
  isCloudflarePage,
  needsJs,
} from "../src/utils/detect"
import { ALTCHA_WIDGET_HTML, FRIENDLY_CAPTCHA_V2_HTML, FRIENDLY_CAPTCHA_WIDGET_HTML } from "./fixtures/pow"
import { withFetch } from "./helpers/fetch"

describe("provider-specific proof-of-work widget detection", () => {
  test("classifies ALTCHA as an embedded JS widget, not a blocking wall", () => {
    expect(hasAltcha(ALTCHA_WIDGET_HTML)).toBe(true)
    expect(detectChallengeType(ALTCHA_WIDGET_HTML)).toBe("altcha")
    expect(needsJs(ALTCHA_WIDGET_HTML, {})).toBe(true)
    expect(isCloudflarePage(ALTCHA_WIDGET_HTML, {})).toBe(false)
    expect(isBlocked(200, ALTCHA_WIDGET_HTML)).toBe(false)
    expect(isChallengeWall(200, ALTCHA_WIDGET_HTML.length, "altcha")).toBe(false)
    expect(isChallengeWall(200, ALTCHA_WIDGET_HTML.length, "altcha", ALTCHA_WIDGET_HTML)).toBe(false)
    expect(isChallengeWall(429, ALTCHA_WIDGET_HTML.length, "altcha")).toBe(true)
  })

  test("classifies dynamic ALTCHA script tags and escalates challenge walls", () => {
    const dynamicAltchaWall = `<!DOCTYPE html>
<html lang="en">
<head><title>Captcha</title></head>
<body>
  <div class="header">...</div>
  <div class="captcha-wrap"><p>JavaScript is required to complete this challenge. Please enable it and reload the page.</p></div>
  <script type="module" src="/js/page_specific/altcha.js"></script>
</body></html>`

    expect(hasAltcha(dynamicAltchaWall)).toBe(true)
    expect(detectChallengeType(dynamicAltchaWall)).toBe("altcha")
    expect(needsJs(dynamicAltchaWall, {})).toBe(true)
    expect(isChallengeWall(200, dynamicAltchaWall.length, "altcha", dynamicAltchaWall)).toBe(true)

    // Alternative script tags (CDN, mjs, minified)
    expect(
      hasAltcha(
        '<script async defer src="https://cdn.jsdelivr.net/npm/altcha/dist/altcha.min.js" type="module"></script>',
      ),
    ).toBe(true)
    expect(hasAltcha('<script type="module" src="/assets/altcha.mjs"></script>')).toBe(true)

    const embeddedDynamicWidget = `<html><head><title>Checkout</title></head><body>
      <main>Order summary</main><div class="captcha-wrap"></div>
      <script type="module" src="/assets/altcha.js"></script>
    </body></html>`
    expect(detectChallengeType(embeddedDynamicWidget)).toBe("altcha")
    expect(isChallengeWall(200, embeddedDynamicWidget.length, "altcha", embeddedDynamicWidget)).toBe(false)
  })

  test("classifies Friendly Captcha v1 and v2 as embedded JS widgets", () => {
    for (const html of [FRIENDLY_CAPTCHA_WIDGET_HTML, FRIENDLY_CAPTCHA_V2_HTML]) {
      expect(hasFriendlyCaptcha(html)).toBe(true)
      expect(detectChallengeType(html)).toBe("friendly-captcha")
      expect(needsJs(html, {})).toBe(true)
      expect(isBlocked(200, html)).toBe(false)
      expect(isChallengeWall(200, html.length, "friendly-captcha")).toBe(false)
    }
  })

  test("keeps an authoritative Cloudflare header ahead of embedded widget markers", () => {
    const headers = { "CF-Mitigated": "Challenge" }
    expect(detectChallengeType(ALTCHA_WIDGET_HTML, headers)).toBe("cloudflare-interstitial")
    expect(isCloudflarePage(ALTCHA_WIDGET_HTML, headers)).toBe(true)
  })

  test("does not classify generic PoW, WebAssembly, mCaptcha, or header references", () => {
    const ordinaryPages = [
      "<article>How proof-of-work protects distributed systems</article>",
      "<article>Our application compiles WebAssembly modules and worker.js.</article>",
      "<h1>mCaptcha integration guide</h1>",
      '<script src="/assets/friendlycaptcha-analytics.js"></script>',
    ]
    for (const html of ordinaryPages) {
      expect(hasAltcha(html)).toBe(false)
      expect(hasFriendlyCaptcha(html)).toBe(false)
      expect(detectChallengeType(html, { "x-pow-challenge": "example" })).toBe("none")
      expect(isBlocked(200, html)).toBe(false)
    }
  })
})

type LocatorLike = {
  first(): LocatorLike
  click(options: { timeout: number; force: boolean }): Promise<void>
  count(): Promise<number>
}

const locator =
  (seen: string[]) =>
  (selector: string): LocatorLike => ({
    first() {
      return this
    },
    async click() {
      seen.push(selector)
    },
    async count() {
      return 0
    },
  })

describe("in-page proof-of-work widget solvers", () => {
  test("detects both widget families without exceeding a short timeout", async () => {
    const mainFrame = {}
    const page = {
      evaluate: async () => true,
      frames: () => [mainFrame],
      mainFrame: () => mainFrame,
    } as unknown as Page

    expect(await hasAltchaWidget(page, 25)).toBe(true)
    expect(await hasFriendlyCaptchaWidget(page, 25)).toBe(true)
  })

  test("starts ALTCHA through verify() and does not click a form control", async () => {
    let calls = 0
    const selectors: string[] = []
    const page = {
      evaluate: async () => {
        calls++
        return calls === 1 || calls === 3 || calls >= 4
      },
      locator: locator(selectors),
    } as unknown as Page

    expect(await solveAltcha(page, 500)).toBe(true)
    expect(selectors).toEqual([])
  })

  test("ALTCHA legacy fallback only targets provider checkbox selectors", async () => {
    let calls = 0
    const selectors: string[] = []
    const page = {
      evaluate: async () => {
        calls++
        if (calls === 1) return true
        if (calls === 2 || calls === 3) return false
        if (calls === 4) return undefined
        return true
      },
      locator: locator(selectors),
    } as unknown as Page

    expect(await solveAltcha(page, 500)).toBe(true)
    expect(selectors).toEqual(['altcha-widget input[type="checkbox"], altcha-widget .altcha-checkbox'])
    expect(selectors.some((selector) => selector.includes("submit"))).toBe(false)
  })

  test("bounds post-verification settling by the remaining solver deadline", async () => {
    let calls = 0
    const timeouts: number[] = []
    const wait = ({ timeout }: { timeout: number }) => {
      timeouts.push(timeout)
      return new Promise<void>((resolve) => setTimeout(resolve, timeout))
    }
    const page = {
      evaluate: async () => {
        calls++
        return calls === 1 || calls >= 4
      },
      locator: locator([]),
      waitForNavigation: wait,
      waitForFunction: (_predicate: () => boolean, options: { timeout: number }) => wait(options),
    } as unknown as Page
    const started = Date.now()

    expect(await solveAltcha(page, 50)).toBe(true)
    expect(timeouts).toHaveLength(2)
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(50)
    expect(Date.now() - started).toBeLessThan(200)
  })

  test("retries Friendly Captcha v2 until its asynchronous provider frame is ready", async () => {
    let evaluateCalls = 0
    let frameReads = 0
    let solved = false
    const selectors: string[] = []
    const mainFrame = {}
    const providerFrame = {
      url: () => "https://global.frcapi.com/api/v2/captcha/widget?sitekey=test",
      locator: (selector: string): LocatorLike => ({
        first() {
          return this
        },
        async click() {
          selectors.push(selector)
          solved = true
        },
        async count() {
          return 1
        },
      }),
    }
    const page = {
      evaluate: async () => {
        evaluateCalls++
        return evaluateCalls === 1 || solved
      },
      frames: () => (++frameReads >= 2 ? [mainFrame, providerFrame] : [mainFrame]),
      mainFrame: () => mainFrame,
      locator: locator(selectors),
    } as unknown as Page

    expect(await solveFriendlyCaptcha(page, 1000)).toBe(true)
    expect(selectors).toEqual(['button[role="checkbox"], .frc-button'])
    expect(selectors.some((selector) => selector.includes("submit"))).toBe(false)
  })

  test("returns promptly when either widget is absent", async () => {
    const mainFrame = {}
    const page = {
      evaluate: async () => false,
      frames: () => [mainFrame],
      mainFrame: () => mainFrame,
    } as unknown as Page
    const started = Date.now()

    expect(await solveAltcha(page, 75)).toBe(false)
    expect(await solveFriendlyCaptcha(page, 75)).toBe(false)
    expect(Date.now() - started).toBeLessThan(400)
  })
})

describe("Tier 1 widget escalation", () => {
  test("escalates ALTCHA and Friendly Captcha shells to browser tiers", async () => {
    for (const [html, challenge, reason] of [
      [ALTCHA_WIDGET_HTML, "altcha", "altcha-shell"],
      [FRIENDLY_CAPTCHA_V2_HTML, "friendly-captcha", "friendly-captcha-shell"],
    ] as const) {
      await withFetch(new Response(html, { status: 200, headers: { "content-type": "text/html" } }), async () => {
        const result = await runTier1("https://example.test/")
        expect(result.status).toBe("needs-js")
        expect(result.challenge).toBe(challenge)
        expect(result.reason).toBe(reason)
      })
    }
  })

  test("does not escalate an unrelated X-PoW-Challenge header", async () => {
    await withFetch(
      new Response("<html><body>ordinary response</body></html>", {
        status: 200,
        headers: { "content-type": "text/html", "x-pow-challenge": "protocol-specific" },
      }),
      async () => {
        const result = await runTier1("https://example.test/")
        expect(result.status).toBe("success")
      },
    )
  })
})
