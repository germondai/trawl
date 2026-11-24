import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { Elysia } from "elysia"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import { solveDataDome } from "../../../packages/tiers/src/solvers/datadome"
import { routeChallengeWait } from "../../../packages/tiers/src/utils/challengeRouter"
import { waitForDataDomeResolution } from "../../../packages/tiers/src/utils/datadomeWait"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

describe.skipIf(process.env.TRAWL_DATADOME_TESTS !== "1")("DataDome browser integration", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let server: ReturnType<typeof Bun.serve>
  let handle: BrowserHandle
  const metrics = new MetricsStore()
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => handle,
    releaseBrowser() {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  let accepted = 0
  const content = `<html><body><h1>Owned destination content</h1><p>${"Complete results. ".repeat(30)}</p></body></html>`
  const wall = `<html><body><script>var dd={'rt':'c','host':'geo.captcha-delivery.com'}</script><p>Owned challenge wall</p></body></html>`

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const headers = { "content-type": "text/html" }
        if (url.pathname === "/cleared") return new Response(content, { headers })
        if (url.pathname === "/verify") {
          const { answer } = await request.json()
          if (answer !== "123456") return new Response("Rejected", { status: 403 })
          accepted++
          return new Response("Accepted", { headers: { "set-cookie": "datadome=owned-clearance; Path=/" } })
        }
        if (url.pathname === "/widget") {
          return new Response(
            `<html><body><button id="captcha__audio__button" onclick="document.querySelector('#panel').hidden=false">Audio</button>
            <div id="panel" hidden><audio class="audio-captcha-track" src="https://dd.prod.captcha-delivery.com/audio/fixture/en/clip.wav"></audio>
            <button class="audio-captcha-play-button">Play</button>
            ${Array.from({ length: 6 }, () => '<input class="audio-captcha-inputs" maxlength="1">').join("")}
            <button class="audio-captcha-submit-button">Verify</button></div><script>
            document.querySelector('.audio-captcha-submit-button').onclick=async()=>{
              const answer=Array.from(document.querySelectorAll('input')).map(x=>x.value).join('');
              const response=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answer})});
              if(response.ok)parent.location.href='/cleared';
            };</script></body></html>`,
            { headers },
          )
        }
        if (url.pathname === "/audio")
          return new Response(wall.replace("</body>", '<iframe src="/widget"></iframe></body>'), { headers })
        if (url.pathname === "/hard-block")
          return new Response('{"url":"https://geo.captcha-delivery.com/captcha/?t=bv"}', {
            status: 403,
            headers: { "content-type": "application/json" },
          })
        return new Response(wall, { status: url.pathname === "/soft-block" ? 200 : 403, headers })
      },
    })
    browser = await launchAnubisBrowser()
    const context = await browser.newContext()
    // No fixture requests may reach a CAPTCHA or STT service.
    await context.route("https://**/*", (route) => route.abort())
    const page = await context.newPage()
    const userAgent = await page.evaluate(() => navigator.userAgent)
    await page.close()
    handle = {
      id: 1,
      lease: 1,
      headful: false,
      browser,
      context,
      fingerprint: { userAgent, platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    server?.stop(true)
    metrics.close()
  })

  test("types into the real iframe and verifies independently accepted content and cookie", async () => {
    const page = await handle.context.newPage()
    try {
      await page.goto(`${server.url}audio`)
      await page.frameLocator("iframe").locator("#captcha__audio__button").waitFor()
      const unexpected = async () => {
        throw new Error("unrelated waiter must not run")
      }
      const outcomes: unknown[] = []
      const result = await routeChallengeWait(
        page as never,
        await page.content(),
        {},
        10000,
        `${server.url}audio`,
        {
          cloudflare: unexpected,
          imperva: unexpected,
          akamai: unexpected,
          ddosGuard: unexpected,
          awsWaf: unexpected,
          dataDome: (p, ms, url, initialCookies, signal) =>
            waitForDataDomeResolution(p, ms, url, { initialCookies, signal }),
          dataDomeCaptcha: (p, ms, signal) =>
            solveDataDome(
              p,
              ms,
              signal,
              async () => "one two three four five six",
              async () => new Uint8Array([1, 2, 3]),
              { typing: [0, 0], keystroke: [0, 0], submit: [0, 0], settle: 0 },
            ),
        },
        200,
        { dataDome: new Set(), awsWaf: new Set() },
        undefined,
        undefined,
        undefined,
        AbortSignal.timeout(10000),
        (items) => outcomes.push(...items),
        () => 200,
      )
      expect(result).toEqual({ challengeType: "datadome", resolution: "ok", captchasSolved: ["datadome"] })
      expect(outcomes).toEqual([{ kind: "datadome", outcome: "solved" }])
      expect(await page.content()).toContain("Owned destination content")
      expect(accepted).toBe(1)
    } finally {
      await page.close()
      await handle.context.clearCookies()
    }
  }, 15000)

  for (const route of ["/scrape", "/v1"]) {
    test.each(["cleared", "soft-block", "http-block", "hard-block"])(
      `${route} handles %s`,
      async (mode) => {
        const app = new Elysia()
          .use(
            scrapeRoute(
              () => deps,
              () => true,
              metrics,
            ),
          )
          .use(
            v1Route({
              orchestratorDeps: () => deps,
              poolReady: () => true,
              metricsStore: metrics,
              cookieFallback: false,
            }),
          )
        const response = await app.handle(
          new Request(`http://localhost${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: `${server.url}${mode}`, cmd: "request.get", maxTier: 3, maxTimeout: 6000 }),
          }),
        )
        const body = await response.json()
        if (mode === "cleared") {
          expect(response.status, JSON.stringify(body)).toBe(200)
          expect(route === "/scrape" ? body.html : body.solution.response).toContain("Owned destination content")
        } else {
          expect(response.status, JSON.stringify(body)).toBe(500)
          if (route === "/v1") expect(body.status).toBe("error")
          else expect(body.error).toBeString()
          expect(body.captchasSolved ?? []).not.toContain("datadome")
        }
        expect(browser.contexts()).toHaveLength(1)
      },
      15000,
    )
  }
})
