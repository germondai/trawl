import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import net from "node:net"
import { FINGERPRINT } from "@trawl/browser"
import { BrowserSessions, type OrchestratorDeps, RequestBudget } from "@trawl/tiers"
import type { BrowserHandle, SessionData } from "@trawl/types"
import { Elysia } from "elysia"
import { launchPublicEgressBrowser } from "../../../packages/browser/tests/helpers/publicEgressBrowser"
import { transcribeAudio } from "../../../packages/tiers/src/solvers/stt"
import { PublicEgressProxy } from "./public-egress"
import { mcpRoute, runMcpScrape } from "./routes/mcp"
import { scrapeRoute } from "./routes/scrape"
import { sessionsRoute } from "./routes/sessions"
import { v1Route } from "./routes/v1"

// Owned loopback fixtures only; the connector maps a validated public IP to our fixture.
describe.skipIf(process.env.TRAWL_MCP_EGRESS_TESTS !== "1")("MCP public network isolation", () => {
  let browser: Awaited<ReturnType<typeof launchPublicEgressBrowser>>
  let origin: ReturnType<typeof Bun.serve>
  let privateOrigin: ReturnType<typeof Bun.serve>
  let guard: PublicEgressProxy
  let sessions: BrowserSessions
  let deps: OrchestratorDeps
  let handle: BrowserHandle
  let privateHits = 0
  let rebindLookups = 0
  const connected: string[] = []
  const cacheKeys: string[] = []
  const cache = new Map<string, SessionData>()
  const content = `<h1>Owned public document</h1><p>${"Real browser egress fixture content. ".repeat(30)}</p>`
  const send = async (path: string, body: unknown) => {
    const app = new Elysia()
      .use(
        sessionsRoute(
          () => deps,
          () => true,
        ),
      )
      .use(
        scrapeRoute(
          () => deps,
          () => true,
        ),
      )
      .use(v1Route({ orchestratorDeps: () => deps, poolReady: () => true }))
    return app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  }
  const mcp = async (args: Record<string, unknown>) => {
    const app = mcpRoute({
      poolReady: () => true,
      runScrape: (input) =>
        runMcpScrape(input, {
          ...deps,
          networkProxy: (upstream) => guard.proxyFor(upstream),
        }),
    })
    const response = await app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "extract",
            arguments: {
              url: `http://1.1.1.1:${origin.port}/`,
              render: true,
              maxTimeout: 15000,
              fields: { title: { selector: "h1" } },
              ...args,
            },
          },
        }),
      }),
    )
    return (await response.json()).result
  }
  beforeAll(async () => {
    privateOrigin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        privateHits++
        return new Response(`<html><body>${content}</body></html>`, { headers: { "content-type": "text/html" } })
      },
    })
    origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname !== "/")
          return new Response("public child", { headers: { "access-control-allow-origin": "*" } })
        return new Response(
          `<html><head><title>Owned fixture</title></head><body>${content}<script>
        (async()=>{
          const get=async url=>{try{return (await fetch(url)).status}catch{return 'blocked'}};
          window.publicStatus=await get('http://rebind.example:${origin.port}/first');
          window.reboundStatus=await get('http://rebind.example:${origin.port}/second');
          window.privateStatus=await get('http://127.0.0.1:${privateOrigin.port}/private');
          const done=document.createElement('p');done.id='egress-done';done.textContent=JSON.stringify([window.publicStatus,window.reboundStatus,window.privateStatus]);document.body.append(done);
        })();
      </script></body></html>`,
          { headers: { "content-type": "text/html", "set-cookie": "cf_clearance=owned; Path=/" } },
        )
      },
    })
    guard = new PublicEgressProxy({
      lookup: async (hostname) => [
        { address: hostname === "rebind.example" && ++rebindLookups > 1 ? "127.0.0.1" : "1.1.1.1", family: 4 },
      ],
      connect: async (address) => {
        connected.push(address)
        return new Promise((resolve, reject) => {
          const socket = net.connect(Number(address === "1.1.1.1" ? origin.port : privateOrigin.port), "127.0.0.1")
          socket.once("error", reject).once("connect", () => resolve(socket))
        })
      },
    })
    browser = await launchPublicEgressBrowser()
    handle = {
      id: 1,
      lease: 1,
      headful: false,
      browser,
      context: await browser.newContext({ viewport: null }),
      fingerprint: FINGERPRINT,
    }
    deps = {
      acquireBrowser: async () => handle,
      releaseBrowser: () => {},
      loadSession: async (key) => {
        cacheKeys.push(key)
        return cache.get(key)
      },
      saveSession: async (key, data) => {
        cacheKeys.push(key)
        cache.set(key, data)
      },
      invalidateSession: async (key) => {
        cacheKeys.push(key)
        cache.delete(key)
      },
    }
    sessions = new BrowserSessions({ ...deps, networkProxy: (upstream) => guard.proxyFor(upstream) })
    deps.sessions = sessions
  }, 45000)
  afterAll(async () => {
    await sessions?.shutdown()
    await browser?.close()
    await guard?.close()
    await origin?.stop(true)
    await privateOrigin?.stop(true)
  })
  test("native /scrape and /v1 retain operator access to private targets", async () => {
    for (const path of ["/scrape", "/v1"]) {
      const response = await send(path, {
        url: `http://127.0.0.1:${privateOrigin.port}/`,
        ...(path === "/v1" ? { cmd: "request.get" } : {}),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.text()).toContain("Owned public document")
    }
    expect(privateHits).toBe(2)
  }, 20000)
  test("browser subrequests cannot rebind or reach loopback, and cache keys stay isolated", async () => {
    privateHits = 0
    cacheKeys.length = 0
    rebindLookups = 0
    connected.length = 0
    cache.set("1.1.1.1", { cookies: [], userAgent: "native-only", savedAt: Date.now() })
    const result = await mcp({ waitForSelector: "#egress-done", fields: { status: { selector: "#egress-done" } } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(JSON.parse(result.content[0].text)[0].status).toBe('[200,"blocked","blocked"]')
    expect(privateHits).toBe(0)
    expect(rebindLookups).toBe(2)
    expect(connected.length).toBeGreaterThan(1)
    expect(connected.every((address) => address === "1.1.1.1")).toBe(true)
    expect(cacheKeys.length).toBeGreaterThan(0)
    expect(cacheKeys.every((key) => key.startsWith("mcp:"))).toBe(true)
    expect(cache.get("1.1.1.1")?.userAgent).toBe("native-only")
    rebindLookups = 0
    const repeated = await mcp({ waitForSelector: "#egress-done" })
    expect(repeated.isError, JSON.stringify(repeated)).not.toBe(true)
    expect(repeated.structuredContent.tier).toBe(2)
    expect(privateHits).toBe(0)
    expect(cacheKeys.every((key) => key.startsWith("mcp:"))).toBe(true)
  }, 25000)
  test("MCP rejects ordinary sessions, while publicOnly kept pages remain guarded after eval", async () => {
    expect((await send("/sessions", { id: "native" })).status).toBe(201)
    expect((await mcp({ sessionId: "native" })).isError).toBe(true)
    expect((await send("/sessions", { id: "public", publicOnly: true, keepPage: true })).status).toBe(201)
    rebindLookups = 0
    const result = await mcp({ sessionId: "public", waitForSelector: "#egress-done" })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    const before = privateHits
    const budget = new RequestBudget(5000)
    try {
      const status = await sessions.evaluate(
        "public",
        `fetch('http://127.0.0.1:${privateOrigin.port}/eval').then(r=>r.status,()=> 'blocked')`,
        budget,
      )
      expect(status).toBe("blocked")
      await sessions.use("public", "", budget, async (_handle, _context, _storage, page) => {
        if (!page) throw new Error("Expected a retained page")
        expect(
          await transcribeAudio(`http://127.0.0.1:${privateOrigin.port}/audio`, budget.signal, page, 3000),
        ).toBeUndefined()
        expect(
          await transcribeAudio(`http://1.1.1.1:${origin.port}/small-audio`, budget.signal, page, 3000),
        ).toBeUndefined()
      })
    } finally {
      budget.dispose()
    }
    expect(privateHits).toBe(before)
  }, 25000)
})
