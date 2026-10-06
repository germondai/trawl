import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserHandle } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import type { SessionData } from "@trawl/types"
import { Elysia } from "elysia"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import { ANUBIS_CHALLENGE } from "../../../packages/tiers/tests/fixtures/anubis"
import { shutdownMitmProxy, startMitmProxy } from "./proxy/server"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

// Opt in against an owned Anubis v1.27 instance configured for fast PoW,
// difficulty 2, whose upstream returns "TRAWL Anubis integration target".
describe.skipIf(process.env.TRAWL_ANUBIS_TESTS !== "1")("Camoufox Anubis integration", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let app: ReturnType<typeof createApp>
  let fixture: ReturnType<typeof Bun.serve>
  let deps: OrchestratorDeps
  let target: string
  let dir: string
  let acquisitions = 0

  function createApp(dependencies: OrchestratorDeps) {
    return new Elysia()
      .use(
        scrapeRoute(
          () => dependencies,
          () => true,
        ),
      )
      .use(v1Route({ poolReady: () => true, orchestratorDeps: () => dependencies }))
      .listen({ port: 0, hostname: "127.0.0.1" })
  }

  beforeAll(async () => {
    target = process.env.TRAWL_ANUBIS_TEST_URL ?? ""
    if (!target) throw new Error("Set TRAWL_ANUBIS_TEST_URL to the owned Anubis fixture")
    dir = mkdtempSync(join(tmpdir(), "trawl-anubis-browser-"))
    browser = await launchAnubisBrowser()
    const context = await browser.newContext({ viewport: null })
    const handle: BrowserHandle = {
      id: 1,
      lease: 1,
      headful: false,
      browser,
      context,
      fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }
    const sessions = new Map<string, SessionData>()
    deps = {
      acquireBrowser: async () => {
        acquisitions++
        return handle
      },
      releaseBrowser: () => {},
      loadSession: async (domain) => sessions.get(domain),
      saveSession: async (domain, session) => {
        sessions.set(domain, session)
      },
      invalidateSession: async (domain) => {
        sessions.delete(domain)
      },
    }
    app = createApp(deps)
    fixture = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        return new Response(
          new URL(request.url).pathname === "/ordinary"
            ? `<html><body>${"Ordinary article. ".repeat(20)}</body></html>`
            : ANUBIS_CHALLENGE,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
  }, 120_000)

  afterAll(async () => {
    await app?.stop()
    fixture?.stop(true)
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function post(path: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${app.server?.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as any }
  }

  test("native API escalates HTTP 200, completes real PoW, and caches the session", async () => {
    const result = await post("/scrape", { url: target, maxTier: 3, maxTimeout: 15000 })
    expect(result.status).toBe(200)
    expect(result.body.tier).toBe(3)
    expect(result.body.html).toContain("TRAWL Anubis integration target")
    expect(result.body.timings[0].reason).toBe("anubis-challenge")
  }, 20000)

  test("cached browser session clears the same Anubis target", async () => {
    const result = await post("/scrape", { url: target, skipHttp: true, maxTier: 2, maxTimeout: 15000 })
    expect(result.status).toBe(200)
    expect(result.body.tier).toBe(2)
    expect(result.body.html).toContain("TRAWL Anubis integration target")
  }, 20000)

  test("FlareSolverr /v1 returns the real upstream content", async () => {
    const result = await post("/v1", { cmd: "request.get", url: target, maxTimeout: 15000 })
    expect(result.status).toBe(200)
    expect(result.body.status).toBe("ok")
    expect(result.body.solution.response).toContain("TRAWL Anubis integration target")
  }, 20000)

  test("HTTP proxy escalates the real Anubis challenge", async () => {
    const proxy = startMitmProxy({ port: 0, host: "127.0.0.1", caDir: dir, deps, maxTier: 3, maxTimeout: 15000 })
    try {
      if (!proxy.server.listening) await once(proxy.server, "listening")
      const address = proxy.server.address()
      if (!address || typeof address === "string") throw new Error("No proxy address")
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          { hostname: "127.0.0.1", port: address.port, path: target, agent: false, headers: { Connection: "close" } },
          (response) => {
            const chunks: Buffer[] = []
            response.on("data", (chunk: Buffer) => chunks.push(chunk))
            response.on("error", reject)
            response.on("end", () => resolve(Buffer.concat(chunks).toString()))
          },
        )
        request.on("error", reject)
        request.setTimeout(18000, () => request.destroy(new Error("Proxy test timed out")))
        request.end()
      })
      expect(body).toContain("TRAWL Anubis integration target")
    } finally {
      await shutdownMitmProxy(proxy)
    }
  }, 20000)

  test("a persistent challenge fails instead of becoming successful content", async () => {
    const url = new URL(fixture.url)
    url.hostname = "localhost"
    const result = await post("/scrape", { url: url.href, maxTier: 3, maxTimeout: 1200 })
    expect(result.status).toBe(500)
    expect(result.body.timings.at(-1).reason).toBe("anubis-challenge-timeout")
  }, 10000)

  test("ordinary HTTP content does not acquire a browser", async () => {
    const before = acquisitions
    const result = await post("/scrape", { url: new URL("/ordinary", fixture.url).href, maxTier: 3 })
    expect(result.status).toBe(200)
    expect(result.body.tier).toBe(1)
    expect(acquisitions).toBe(before)
  })
})
