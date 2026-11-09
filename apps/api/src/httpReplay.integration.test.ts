import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type BrowserHandle, MemorySessionCache } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { Elysia } from "elysia"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

describe.skipIf(process.env.TRAWL_HTTP_REPLAY_TESTS !== "1")("verified generic HTTP sessions", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let handle: BrowserHandle
  let origin: ReturnType<typeof Bun.serve>
  let postRequests = 0
  const content = '<h1>Verified application content</h1><a href="/correct">Details</a>'

  beforeAll(async () => {
    origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (
          ["/post-reload", "/post-cf-header", "/post-browser-error", "/post-cf-markup", "/post-anubis"].includes(path)
        ) {
          if (request.method === "POST") postRequests++
          if (path === "/post-browser-error" && postRequests === 2)
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("<html><body>Submission recorded"))
                  setTimeout(() => controller.error(new Error("Owned partial response")), 20)
                },
              }),
              { headers: { "content-type": "text/html" } },
            )
          const recovery = ["/post-cf-header", "/post-cf-markup", "/post-anubis"].includes(path)
          const challenged = postRequests === 1 || (recovery && postRequests === 2)
          const reload = postRequests === 2 && path === "/post-reload"
          const wall =
            path === "/post-anubis" && postRequests === 2
              ? '<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast"},"challenge":{"id":"owned","randomData":"owned"}}</script>'
              : "<script>window._cf_chl_opt={}</script>"
          return new Response(
            `<html><head><title>${challenged ? "Just a moment..." : "Submission recorded"}</title></head><body>${challenged ? wall : "Submission recorded"}${reload ? "<script>setTimeout(() => location.reload(), 50)</script>" : ""}</body></html>`,
            {
              status: challenged ? 403 : 200,
              headers: {
                "content-type": "text/html",
                ...(challenged && !(postRequests === 2 && ["/post-cf-markup", "/post-anubis"].includes(path))
                  ? { "cf-mitigated": "challenge" }
                  : {}),
              },
            },
          )
        }
        if (path === "/app.js")
          return new Response(`document.querySelector('#app').innerHTML = ${JSON.stringify(content)}`, {
            headers: { "content-type": "application/javascript" },
          })
        if (path === "/cookie-handoff" || path === "/cookie-handoff-none")
          return new Response(
            `<html><head><title>Owned application</title></head><body>${content}${path === "/cookie-handoff" ? '<script>document.cookie="cf_clearance=owned-handoff; Path=/"</script>' : ""}</body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        if (!request.headers.get("cookie")?.includes("session=owned")) {
          return new Response(
            '<html><head><title>Just a moment...</title></head><body><script>document.cookie="session=owned; Path=/";location.reload()</script></body></html>',
            { headers: { "content-type": "text/html" } },
          )
        }
        return new Response(
          `<html><head><title>Owned application</title></head><body><nav>Site navigation</nav><main id="app">${path === "/static" ? content : ""}</main><script src="/app.js"></script></body></html>`,
          { headers: { "content-type": "text/html", "cache-control": "no-store" } },
        )
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
    }
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    origin?.stop(true)
  })

  const handoffClient = (cookieFallback = true) => {
    const cache = new MemorySessionCache({ ttlSeconds: 60 })
    const metrics = new MetricsStore()
    let checkouts = 0
    let lastTier = 0
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => {
        checkouts++
        return handle
      },
      releaseBrowser: () => {},
      loadSession: (domain) => cache.load(domain),
      saveSession: (domain, data) => cache.save(domain, data),
      invalidateSession: (domain) => cache.invalidate(domain),
      onTierAttempt: (attempt) => {
        lastTier = attempt.tier
      },
    }
    const app = new Elysia()
      .use(v1Route({ cookieFallback, orchestratorDeps: () => deps, poolReady: () => true, metricsStore: metrics }))
      .use(
        scrapeRoute(
          () => deps,
          () => true,
          metrics,
        ),
      )
    const send = (route = "/v1", path = "/cookie-handoff", body: Record<string, unknown> = {}) =>
      app.handle(
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmd: "request.get", url: new URL(path, origin.url).href, maxTimeout: 10000, ...body }),
        }),
      )
    return { send, metrics, cache, checkouts: () => checkouts, lastTier: () => lastTier }
  }

  test.each(["/post-reload", "/post-cf-header", "/post-browser-error", "/post-cf-markup", "/post-anubis"])(
    "guards browser POST reloads and preserves explicit challenge recovery: %s",
    async (path) => {
      postRequests = 0
      const client = handoffClient()
      const target = new URL(path, origin.url)
      try {
        await client.cache.save(target.hostname, {
          cookies: [
            {
              name: "cf_clearance",
              value: "owned",
              domain: target.hostname,
              path: "/",
              expires: -1,
              secure: false,
              httpOnly: true,
            },
          ],
          userAgent: handle.fingerprint.userAgent,
          savedAt: Date.now(),
          httpOrigin: target.origin,
        })
        const response = await client.send("/scrape", path, {
          method: "POST",
          body: "field=value",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          httpReplay: true,
          maxTimeout: 5000,
          solveEmbeddedCaptchas: false,
          allowShortContent: true,
        })
        await response.json()
        const recovery = ["/post-cf-header", "/post-cf-markup", "/post-anubis"].includes(path)
        expect(postRequests).toBe(recovery ? 3 : 2)
        if (recovery) expect(response.status).toBe(200)
      } finally {
        client.metrics.close()
        client.cache.close()
      }
    },
    15000,
  )

  test("/v1 cookie-handoff fallback obtains cookies once and reuses HTTP clearance", async () => {
    const client = handoffClient()
    const { send, metrics, cache } = client
    try {
      const first = await send()
      expect(first.status).toBe(200)
      const result = await first.json()
      expect(result.solution.response).toContain(content)
      expect(result.solution.cookies).toContainEqual(
        expect.objectContaining({ name: "cf_clearance", value: "owned-handoff" }),
      )
      expect(client.checkouts()).toBe(1)
      expect(client.lastTier()).toBe(3)
      const repeat = await send()
      expect(repeat.status).toBe(200)
      expect((await repeat.json()).solution.cookies).toContainEqual(expect.objectContaining({ name: "cf_clearance" }))
      expect(client.lastTier()).toBe(1)
      expect(client.checkouts()).toBe(1)
      expect(metrics.snapshot().requests).toBe(2)
      expect(metrics.snapshot().failures).toBe(0)
    } finally {
      metrics.close()
      cache.close()
    }
  }, 25000)

  test("/v1 cookie-handoff fallback reports failure when the browser also returns no cookies", async () => {
    const client = handoffClient()
    try {
      const response = await client.send("/v1", "/cookie-handoff-none")
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        status: "error",
        message: expect.stringContaining("no usable cookies"),
      })
      expect(client.checkouts()).toBe(1)
      expect(client.metrics.snapshot()).toMatchObject({ requests: 1, failures: 1 })
    } finally {
      client.metrics.close()
      client.cache.close()
    }
  }, 15000)

  test.each([
    { name: "disabled policy", enabled: false, route: "/v1", cmd: "request.get" },
    { name: "POST", enabled: true, route: "/v1", cmd: "request.post" },
    { name: "native scrape", enabled: true, route: "/scrape", cmd: "request.get" },
  ])("cookie-handoff fallback leaves $name on the HTTP path", async ({ enabled, route, cmd }) => {
    const client = handoffClient(enabled)
    try {
      const response = await client.send(route, "/cookie-handoff", { cmd })
      expect(response.status).toBe(200)
      const result = await response.json()
      expect(route === "/v1" ? result.solution.cookies : result.cookies).toEqual([])
      expect(client.checkouts()).toBe(0)
      expect(client.metrics.snapshot()).toMatchObject({ requests: 1, failures: 0 })
    } finally {
      client.metrics.close()
      client.cache.close()
    }
  })

  for (const route of ["/scrape", "/v1"] as const) {
    for (const path of ["/static", "/dynamic"] as const) {
      test(`${route} reuses complete HTTP content and retains browser rendering for ${path}`, async () => {
        const cache = new MemorySessionCache({ ttlSeconds: 60 })
        let checkouts = 0
        let lastTier = 0
        const deps: OrchestratorDeps = {
          acquireBrowser: async () => {
            checkouts++
            return handle
          },
          releaseBrowser: () => {},
          loadSession: (domain) => cache.load(domain),
          saveSession: (domain, data) => cache.save(domain, data),
          invalidateSession: (domain) => cache.invalidate(domain),
          onTierAttempt: (attempt) => {
            lastTier = attempt.tier
          },
        }
        const metrics = new MetricsStore()
        const app = new Elysia()
          .use(
            scrapeRoute(
              () => deps,
              () => true,
              metrics,
            ),
          )
          .use(v1Route({ orchestratorDeps: () => deps, poolReady: () => true, metricsStore: metrics }))
        const send = async () => {
          const response = await app.handle(
            new Request(`http://localhost${route}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url: `http://127.0.0.1:${origin.port}${path}`,
                cmd: "request.get",
                maxTimeout: 10000,
                solveEmbeddedCaptchas: false,
              }),
            }),
          )
          const result = await response.json()
          expect(response.status).toBe(200)
          expect(route === "/scrape" ? result.html : result.solution.response).toContain(content)
        }
        await send()
        expect(checkouts).toBe(1)
        await send()
        expect(lastTier).toBe(path === "/static" ? 1 : 2)
        expect(checkouts).toBe(path === "/static" ? 1 : 2)
      }, 25000)
    }
  }
})
