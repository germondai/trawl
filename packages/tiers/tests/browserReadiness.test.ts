import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"
import { ACCESS_DENIED, CLOUDFLARE_ORIGIN_ERROR, VERIFICATION_REQUIRED } from "./fixtures/terminalResponses"

const html = `<html><body>${"Ready document ".repeat(20)}</body></html>`

function fixture(anubisContent = true, documentHtml = html) {
  const waits: string[] = []
  const verifications: number[] = []
  let closed = 0
  const page = {
    route: async () => {},
    on: () => {},
    setExtraHTTPHeaders: async () => {},
    mainFrame: () => page,
    goto: async () => undefined,
    content: async () => documentHtml,
    title: async () => "Fixture",
    context: () => context,
    close: async () => {
      closed++
    },
    url: () => "https://fixture.example/",
    frames: () => [],
    isClosed: () => false,
    evaluateHandle: async () => ({
      evaluate: async (read: any) =>
        read({
          verified() {
            verifications.push(performance.now())
            return true
          },
          disconnect() {},
        }),
      dispose: async () => {},
    }),
    evaluate: async (fn: unknown) => {
      const source = String(fn)
      if (source.includes("anubis_challenge")) return { ready: true, content: anubisContent }
      if (source.includes("cf-turnstile-response")) {
        if (source.includes('return "token"')) return "token"
        verifications.push(performance.now())
        return true
      }
      if (source.includes("widgetSelector")) {
        if (source.includes("validResponse")) verifications.push(performance.now())
        return documentHtml.includes("frc-captcha")
      }
      return "fixture-agent"
    },
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
  return { handle, page, waits, verifications, closed: () => closed }
}

describe("browser document readiness", () => {
  for (const tier of [2, 3] as const) {
    for (const late of [false, true]) {
      test.each([
        [ACCESS_DENIED, "blocked", "akamai-access-denied"],
        [VERIFICATION_REQUIRED, "blocked", "automated-access-verification-required"],
        [CLOUDFLARE_ORIGIN_ERROR, "error", "cloudflare-origin-http-522"],
      ] as const)(
        `Tier ${tier} rejects a terminal document (${late ? "after loading" : "on navigation"})`,
        async (terminalHtml, status, reason) => {
          const site = fixture(true, late ? html : terminalHtml)
          if (late) {
            let loaded = false
            site.page.content = async () => (loaded ? terminalHtml : html)
            site.page.waitForLoadState = async () => {
              loaded = true
            }
          }
          const result =
            tier === 2
              ? await runTier2(
                  "https://fixture.example/",
                  site.handle,
                  { cookies: [], userAgent: "fixture-agent", savedAt: 1 },
                  2000,
                )
              : await runTier3("https://fixture.example/", site.handle, 2000)
          expect(result.status).toBe(status)
          expect(result.reason).toBe(reason)
          expect(site.closed()).toBe(1)
        },
      )
    }
  }

  for (const tier of [2, 3] as const) {
    test(`Tier ${tier} skips embedded verification only when requested`, async () => {
      const site = fixture(true, html.replace("</body>", '<div class="cf-turnstile"></div></body>'))
      const capture = { solveEmbeddedCaptchas: false }
      const result =
        tier === 2
          ? await runTier2(
              "https://fixture.example/",
              site.handle,
              { cookies: [], userAgent: "fixture-agent", savedAt: 1 },
              10000,
              undefined,
              undefined,
              undefined,
              undefined,
              false,
              capture,
            )
          : await runTier3(
              "https://fixture.example/",
              site.handle,
              10000,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              false,
              capture,
            )
      expect(result.status).toBe("success")
      expect(result.captchasSolved ?? []).toEqual([])
      expect(site.verifications).toEqual([])
    })
  }

  test("Cloudflare retains content scheduled after the load event", async () => {
    const site = fixture()
    let first = true
    let loadedAt = Infinity
    site.page.content = async () => {
      if (first) {
        first = false
        return '<html><title>Just a moment...</title><body id="challenge-form">Checking your browser</body></html>'
      }
      return html.replace(
        "</body>",
        `${performance.now() - loadedAt >= 450 ? "<article>Loaded after onload</article>" : ""}</body>`,
      )
    }
    site.page.waitForLoadState = async () => {
      await Bun.sleep(600)
      loadedAt = performance.now()
    }
    const result = await runTier3("https://fixture.example/", site.handle, 6000)
    expect(result.status).toBe("success")
    expect(result.html).toContain("<article>Loaded after onload</article>")
  })

  test.each([
    ["friendly-captcha", '<div class="frc-captcha"></div>'],
    ["turnstile", '<div class="cf-turnstile"></div>'],
  ])("%s verification starts promptly while retaining the JS settling window", async (kind, markup) => {
    const documentHtml = html.replace("</body>", `${markup}</body>`)
    const site = fixture(true, documentHtml)
    const start = performance.now()
    const result = await runTier3("https://fixture.example/", site.handle, 6000)
    expect(result.status).toBe("success")
    expect(result.captchasSolved).toContain(kind)
    expect(result.html).toBe(documentHtml)
    expect((site.verifications[0] ?? Infinity) - start).toBeLessThan(500)
    expect(performance.now() - start).toBeGreaterThanOrEqual(500)
  })

  test("overlapping verification retains discovery of a late-mounted widget", async () => {
    const site = fixture(true, html.replace("</body>", '<div class="frc-captcha"></div></body>'))
    const evaluate = site.page.evaluate
    const start = performance.now()
    site.page.evaluate = async (fn: unknown) => {
      if (String(fn).includes("widgetSelector") && !String(fn).includes("validResponse"))
        return performance.now() - start >= 5200
      return evaluate(fn)
    }
    const result = await runTier3("https://fixture.example/", site.handle, 12000)
    expect(result.status).toBe("success")
    expect(result.captchasSolved).toContain("friendly-captcha")
  }, 8000)

  test("cached Anubis content uses the provider readiness check", async () => {
    const site = fixture()
    const result = await runTier2(
      "https://fixture.example/",
      site.handle,
      { cookies: [], userAgent: "fixture-agent", savedAt: 1 },
      900,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { anubisDetected: true },
    )
    expect(result.status).toBe("success")
    expect(result.html).toBe(html)
    expect(site.waits).not.toContain("networkidle")
  })

  test("cached Anubis content must still pass the provider readiness check", async () => {
    const site = fixture(false)
    const result = await runTier2(
      "https://fixture.example/",
      site.handle,
      { cookies: [], userAgent: "fixture-agent", savedAt: 1 },
      450,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { anubisDetected: true },
    )
    expect(result.status).toBe("timeout")
    expect(site.closed()).toBe(1)
  })

  test("ordinary cached pages retain the default JS settling", async () => {
    const site = fixture()
    const result = await runTier2(
      "https://fixture.example/",
      site.handle,
      { cookies: [], userAgent: "fixture-agent", savedAt: 1 },
      900,
    )
    expect(result.status).toBe("success")
    expect(site.waits).toContain("networkidle")
  })

  test("ordinary fresh pages wait for delayed JavaScript before capturing content", async () => {
    const site = fixture()
    let ready = false
    site.page.content = async () =>
      html.replace("</body>", `${ready ? "<article>Loaded by JavaScript</article>" : ""}</body>`)
    site.page.waitForLoadState = async (state: string) => {
      site.waits.push(state)
      if (state === "networkidle") ready = true
    }
    const result = await runTier3("https://fixture.example/", site.handle, 6000)
    expect(result.status).toBe("success")
    expect(result.html).toContain("<article>Loaded by JavaScript</article>")
  })

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
