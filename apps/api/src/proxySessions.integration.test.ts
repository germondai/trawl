import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { MemorySessionCache } from "@trawl/browser"
import { type OrchestratorDeps, ProxyPool } from "@trawl/tiers"
import type { TierResult } from "@trawl/types"
import { Elysia } from "elysia"
import { parseHTML } from "linkedom"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

describe.skipIf(process.env.TRAWL_PROXY_SESSION_TESTS !== "1")("Camoufox proxy session reuse", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let handle: BrowserHandle
  let origin: ReturnType<typeof Bun.serve>
  let proxy: ReturnType<typeof Bun.serve>
  let temporaryContexts = 0
  const cache = new MemorySessionCache({ ttlSeconds: 60 })
  const metrics = new MetricsStore()
  const attempts: TierResult[] = []
  const requests: { path: string; proxy: boolean; cookie: string; agent: string }[] = []
  let deps: OrchestratorDeps
  let app: ReturnType<typeof createApp>
  const renderedText = "Owned rendered results. ".repeat(8)
  const fragments: Record<string, { source: string; expected: string }> = {
    "/utf8-fragment": {
      source:
        '<!doctype html><link rel="stylesheet" href="data:text/css,div{}"><div id="result" data-ct="第1話">中文内容</div><script>document.body.append(document.createElement("iframe"))</script>',
      expected: "中文内容",
    },
    "/rendered-fragment": {
      source: `<div id="result">Loading 中文</div><script>document.querySelector('#result').textContent=${JSON.stringify(renderedText)}</script>`,
      expected: renderedText,
    },
    "/solved-fragment": {
      source: `<div id="challenge-running">Checking your browser 请稍候</div><script>setTimeout(()=>{document.querySelector('script').remove();document.getElementById('challenge-running').remove();const result=document.createElement('main');result.id='result';result.textContent=${JSON.stringify(renderedText)};document.body.append(result)},150)</script>`,
      expected: renderedText,
    },
  }
  const target = (path = "/") => `http://proxy-session.invalid:${origin.port}${path}`
  const createApp = () =>
    new Elysia()
      .use(
        scrapeRoute(
          () => deps,
          () => true,
          metrics,
        ),
      )
      .use(v1Route({ poolReady: () => true, orchestratorDeps: () => deps, metricsStore: metrics }))
  const send = async (
    route: string,
    url = target(),
    maxTimeout = 10000,
    maxTier = 3,
    solveEmbeddedCaptchas = false,
    requestProxy?: { url: string; username: string; password: string },
  ) => {
    attempts.length = 0
    const response = await app.handle(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          maxTimeout,
          maxTier,
          cmd: "request.get",
          solveEmbeddedCaptchas,
          proxy: requestProxy,
        }),
      }),
    )
    return { status: response.status, body: await response.json(), attempts: [...attempts] }
  }

  beforeAll(async () => {
    origin = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        const proxied = request.headers.get("x-owned-proxy") === "yes"
        const cookie = request.headers.get("cookie") ?? ""
        requests.push({ path, proxy: proxied, cookie, agent: request.headers.get("user-agent") ?? "" })
        if (path === "/slow") await Bun.sleep(10000)
        if (path !== "/public" && !cookie.includes(`cf_clearance=${proxied ? "proxy" : "direct"}`)) {
          return new Response(
            `<html><head><title>Just a moment...</title></head><body><form id="challenge-form">Checking your browser</form><script>document.cookie='cf_clearance=${proxied ? "proxy" : "direct"}; Path=/; SameSite=Lax';location.reload()</script></body></html>`,
            {
              headers: { "content-type": "text/html" },
            },
          )
        }
        if (fragments[path]) return new Response(fragments[path].source, { headers: { "content-type": "text/html" } })
        return new Response(
          `<html><body><h1>Owned protected content</h1><p>${"Complete results. ".repeat(40)}</p>${path === "/widget" ? '<form><div class="g-recaptcha" data-sitekey="owned-sitekey" data-callback="owned.accept"></div><textarea name="g-recaptcha-response" hidden></textarea></form><script>window.owned={accept(token){if(token==="owned-token")document.body.dataset.accepted="true"}}</script>' : ""}</body></html>`,
          {
            headers: { "content-type": "text/html", "set-cookie": "rotated=yes; Path=/; HttpOnly" },
          },
        )
      },
    })
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const incoming = new URL(request.url)
        if (incoming.hostname !== "proxy-session.invalid") return new Response("Unexpected target", { status: 502 })
        incoming.hostname = "127.0.0.1"
        const headers = new Headers(request.headers)
        headers.delete("host")
        headers.set("x-owned-proxy", "yes")
        return fetch(incoming, { headers, redirect: "manual", decompress: false })
      },
    })
    browser = await launchAnubisBrowser()
    const context = await browser.newContext()
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
      noteTemporaryContext: () => {
        temporaryContexts++
      },
    }
    deps = {
      minTier: 2,
      acquireBrowser: async () => handle,
      releaseBrowser() {},
      loadSession: (domain) => cache.load(domain),
      saveSession: (domain, session) => cache.save(domain, session),
      invalidateSession: (domain) => cache.invalidate(domain),
      proxyPool: new ProxyPool([`http://127.0.0.1:${proxy.port}`]),
      onTierAttempt: (attempt) => {
        attempts.push(attempt)
      },
    }
    app = createApp()
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    proxy?.stop(true)
    origin?.stop(true)
    cache.close()
    metrics.close()
  })

  test.each(["/scrape", "/v1"])(
    "reuses the winning proxy and cookies across %s and the other API",
    async (firstRoute) => {
      await cache.invalidate("proxy-session.invalid")
      const first = await send(firstRoute)
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect(first.attempts.map((attempt) => attempt.tier)).toEqual([3])
      const saved = await cache.load("proxy-session.invalid")
      expect(saved?.cookies.some((cookie) => cookie.name === "cf_clearance" && cookie.value === "proxy")).toBe(true)
      const contextsBefore = temporaryContexts
      const start = requests.length
      const second = await send(firstRoute === "/scrape" ? "/v1" : "/scrape", target(), 10000, 2)
      expect(second.status, JSON.stringify(second.body)).toBe(200)
      expect(second.attempts.map((attempt) => ({ tier: attempt.tier, status: attempt.status }))).toEqual([
        { tier: 2, status: "success" },
      ])
      expect(JSON.stringify(second.body)).toContain("Owned protected content")
      const replay = requests.slice(start).filter((request) => request.path === "/")
      expect(replay.length).toBeGreaterThan(0)
      expect(
        replay.every(
          (request) =>
            request.proxy && request.cookie.includes("cf_clearance=proxy") && request.agent === saved?.userAgent,
        ),
      ).toBe(true)
      expect(temporaryContexts).toBe(contextsBefore + 1)
      expect(browser.contexts()).toHaveLength(1)
      expect((await cache.load("proxy-session.invalid"))?.cookies.some((cookie) => cookie.name === "rotated")).toBe(
        true,
      )
    },
    30000,
  )

  test("reuses clearance for Prowlarr's explicit proxy payload", async () => {
    const requestProxy = { url: `http://127.0.0.1:${proxy.port}`, username: "fixture", password: "fixture" }
    const first = await send("/v1", target(), 10000, 3, false, requestProxy)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.attempts.map(({ tier }) => tier)).toEqual([3])
    const start = requests.length
    const second = await send("/v1", target(), 10000, 2, false, requestProxy)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.attempts.map(({ tier }) => tier)).toEqual([2])
    expect(requests.slice(start).some(({ proxy, cookie }) => proxy && cookie.includes("cf_clearance=proxy"))).toBe(true)
  }, 30000)

  test("closes the proxied context on timeout and leaves the pooled context usable", async () => {
    await cache.invalidate("proxy-session.invalid")
    const initial = await send("/scrape")
    expect(initial.status, JSON.stringify(initial.body)).toBe(200)
    const result = await send("/scrape", target("/slow"), 5000, 2)
    expect(result.status).toBe(500)
    expect(JSON.stringify(result.body)).toContain("Scrape deadline exceeded")
    expect(requests.some((request) => request.path === "/slow" && request.proxy)).toBe(true)
    expect(browser.contexts()).toHaveLength(1)
    const page = await handle.context.newPage()
    await page.goto(`http://127.0.0.1:${origin.port}/public`)
    expect(await page.content()).toContain("Owned protected content")
    await page.close()
  }, 20000)

  test.each(["/scrape", "/v1"])(
    "preserves static UTF-8 fragments and rendered content through %s",
    async (route) => {
      await cache.invalidate("proxy-session.invalid")
      for (const [path, fixture] of Object.entries(fragments)) {
        const result = await send(route, target(path), 15000)
        expect(result.status, JSON.stringify(result.body)).toBe(200)
        const html = route === "/v1" ? result.body.solution.response : result.body.html
        const document = parseHTML(html).document
        expect(document.querySelector("#result")?.textContent).toBe(fixture.expected)
        expect(document.querySelector("#challenge-running")).toBeNull()
      }
      expect(browser.contexts()).toHaveLength(1)
    },
    60000,
  )

  test("retains the shared-context fast path for direct cached sessions", async () => {
    deps.proxyPool = undefined
    const direct = `http://127.0.0.1:${origin.port}/public`
    const first = await send("/scrape", direct)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const before = temporaryContexts
    const second = await send("/scrape", direct, 10000, 2)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body).toMatchObject({ tier: 2, sessionCached: true, proxyUsed: false })
    expect(temporaryContexts).toBe(before)
    expect(browser.contexts()).toHaveLength(1)
  }, 30000)

  test("retains the browser proxy in an external CAPTCHA task during cached reuse", async () => {
    deps.proxyPool = new ProxyPool([`http://127.0.0.1:${proxy.port}`])
    await cache.invalidate("proxy-session.invalid")
    const first = await send("/scrape")
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const originalFetch = globalThis.fetch
    const tasks: Record<string, unknown>[] = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const endpoint = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (endpoint.hostname !== "api.2captcha.com") return originalFetch(input, init)
      if (endpoint.pathname === "/createTask") {
        tasks.push(JSON.parse(String(init?.body)).task)
        return Promise.resolve(Response.json({ errorId: 0, taskId: 1 }))
      }
      return Promise.resolve(
        Response.json({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "owned-token" } }),
      )
    }) as typeof fetch
    deps.externalCaptcha = { apiKey: "owned-key", maxTasks: 1, localTimeoutMs: 100, timeoutMs: 12000 }
    try {
      const result = await send("/scrape", target("/widget"), 15000, 2, true)
      expect(result.status, JSON.stringify(result.body)).toBe(200)
      expect(result.body.tier).toBe(2)
      expect(result.body.proxyUsed).toBe(true)
      expect(result.body.captchasSolved).toEqual(["recaptcha-v2:2captcha"])
      expect(result.body.html).toContain('data-accepted="true"')
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        type: "RecaptchaV2Task",
        proxyType: "http",
        proxyAddress: "127.0.0.1",
        proxyPort: proxy.port,
      })
      expect(browser.contexts()).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
      deps.externalCaptcha = undefined
    }
  }, 30000)
})
