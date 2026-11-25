import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { type OrchestratorDeps, ProxyPool } from "@trawl/tiers"
import type { TierResult } from "@trawl/types"
import { Elysia } from "elysia"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import {
  ACCESS_DENIED,
  CLOUDFLARE_ORIGIN_ERROR,
  ORDINARY_RESPONSE_CONTROLS,
  VERIFICATION_REQUIRED,
} from "../../../packages/tiers/tests/fixtures/terminalResponses"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

describe.skipIf(process.env.TRAWL_TERMINAL_RESPONSE_TESTS !== "1")("terminal response API integration", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let handle: BrowserHandle
  let origin: ReturnType<typeof Bun.serve>
  let proxy: ReturnType<typeof Bun.serve>
  const metrics = new MetricsStore()
  const attempts: TierResult[] = []
  let proxyRequests = 0
  const content = `<html><head><title>Owned content</title></head><body><h1>Owned destination</h1><p>${"Complete result. ".repeat(30)}</p></body></html>`

  beforeAll(async () => {
    origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        const headers = { "content-type": "text/html" }
        if (path === "/denied") return new Response(ACCESS_DENIED, { headers })
        if (path === "/verification") return new Response(VERIFICATION_REQUIRED, { headers })
        if (path === "/origin")
          return new Response(CLOUDFLARE_ORIGIN_ERROR, { status: 522, headers: { ...headers, server: "cloudflare" } })
        if (path.startsWith("/control/"))
          return new Response(ORDINARY_RESPONSE_CONTROLS[Number(path.split("/")[2])], { headers })
        if (/^\/challenge\/(403|503)$/.test(path) && !request.headers.get("cookie")?.includes("owned-clearance=yes"))
          return new Response(
            '<html><head><title>Just a moment...</title></head><body><form id="challenge-form">Checking your browser</form><script>document.cookie="owned-clearance=yes; Path=/";location.reload()</script></body></html>',
            { status: Number(path.split("/")[2]), headers },
          )
        return new Response(content, { headers })
      },
    })
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const target = new URL(request.url)
        if (target.hostname !== "terminal-fixture.invalid") return new Response("Unexpected target", { status: 502 })
        proxyRequests++
        target.hostname = "127.0.0.1"
        const headers = new Headers(request.headers)
        headers.delete("host")
        return fetch(target, { headers, redirect: "manual", decompress: false })
      },
    })
    browser = await launchAnubisBrowser()
    const context = await browser.newContext()
    handle = {
      id: 1,
      lease: 1,
      headful: false,
      browser,
      context,
      fingerprint: { userAgent: "fixture-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    origin?.stop(true)
    proxy?.stop(true)
    metrics.close()
  })

  for (const route of ["/scrape", "/v1"]) {
    for (const proxied of [false, true]) {
      test.each([
        "denied",
        "verification",
        "origin",
        "control/2",
        "control/3",
        "control/6",
        "challenge/403",
        "challenge/503",
      ])(
        `${route} classifies %s (${proxied ? "proxy" : "direct"})`,
        async (path) => {
          attempts.length = 0
          const proxyBefore = proxyRequests
          const pool = proxied ? new ProxyPool([String(proxy.url)]) : undefined
          const residential = new ProxyPool(["http://residential.invalid:8080"])
          const deps: OrchestratorDeps = {
            minTier: 3,
            proxyPool: pool,
            residentialProxyPool: path === "origin" ? residential : undefined,
            acquireBrowser: async () => handle,
            releaseBrowser() {},
            loadSession: async () => undefined,
            saveSession: async () => {},
            invalidateSession: async () => {},
            onTierAttempt: (attempt) => attempts.push(attempt),
          }
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
          const started = performance.now()
          const response = await app.handle(
            new Request(`http://localhost${route}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                cmd: "request.get",
                url: `http://${proxied ? "terminal-fixture.invalid" : "127.0.0.1"}:${origin.port}/${path}`,
                maxTier: path === "origin" ? 4 : 3,
                maxTimeout: path === "origin" ? 3000 : 6000,
                solveEmbeddedCaptchas: false,
              }),
            }),
          )
          const body = await response.json()
          if (["denied", "verification", "origin"].includes(path)) {
            expect(response.status, JSON.stringify(body)).toBe(500)
            if (route === "/scrape") expect(body.error).toBeString()
            else expect(body.status).toBe("error")
            expect(attempts.at(-1)?.status).toBe(path === "origin" ? "error" : "blocked")
            if (path === "origin") {
              expect(attempts.at(-1)?.reason).toBe("cloudflare-origin-http-522")
              expect(performance.now() - started).toBeLessThan(2000)
              expect(pool?.hasAvailable() ?? true).toBe(true)
              expect(residential.hasAvailable()).toBe(true)
              expect(attempts.map((attempt) => attempt.tier)).toEqual([3])
            }
          } else {
            expect(response.status, JSON.stringify(body)).toBe(200)
            const html = route === "/scrape" ? body.html : body.solution.response
            expect(html).toContain(path.startsWith("challenge") ? "Owned destination" : "<")
          }
          if (proxied) expect(proxyRequests).toBeGreaterThan(proxyBefore)
          expect(browser.contexts()).toHaveLength(1)
        },
        15000,
      )
    }
  }
})
