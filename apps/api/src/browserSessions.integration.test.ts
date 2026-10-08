import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Elysia } from "elysia"
import { RequestBudget } from "../../../packages/tiers/src/utils/deadline"
import { getDeps, getPool, initPool, shutdownPools } from "./deps"
import { scrapeRoute } from "./routes/scrape"
import { sessionsRoute } from "./routes/sessions"
import { v1Route } from "./routes/v1"

const createApi = () => new Elysia().use(sessionsRoute()).use(scrapeRoute()).use(v1Route()).listen(0)

describe.skipIf(process.env.TRAWL_BROWSER_SESSION_TESTS !== "1")("persistent browser session integration", () => {
  let fixture: ReturnType<typeof Bun.serve>
  let api: ReturnType<typeof createApi>
  let posts = 0
  const url = (path: string) => `http://127.0.0.1:${fixture.port}${path}`
  const send = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`http://127.0.0.1:${api.server?.port}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  beforeAll(async () => {
    fixture = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/slow") await Bun.sleep(2000)
        if (path === "/login" && request.method === "POST") {
          posts++
          expect(await request.text()).toBe("user=fixture")
          return new Response(null, {
            status: 302,
            headers: { location: "/account", "set-cookie": "fixture_login=yes; HttpOnly; Path=/; SameSite=Lax" },
          })
        }
        const loggedIn = request.headers.get("cookie")?.includes("fixture_login=yes") ?? false
        return new Response(
          `<html><head><title>Owned account fixture</title></head><body data-login="${loggedIn}"><h1>Account</h1><p>${"Local browser session integration content. ".repeat(30)}</p><script>${path === "/storage" ? "localStorage.setItem('session-marker','retained');sessionStorage.setItem('tab-marker','retained');" : ""}document.body.dataset.storage=localStorage.getItem('session-marker')||'empty';document.body.dataset.tabStorage=sessionStorage.getItem('tab-marker')||'empty';${path === "/logout-storage" ? "setTimeout(()=>{sessionStorage.clear();location.href='/account'},100);" : ""}</script></body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    await initPool({ poolSize: 1, headfulPoolSize: 0 })
    api = createApi()
  }, 120000)
  afterAll(async () => {
    await api?.stop()
    await shutdownPools()
    fixture?.stop(true)
  })

  test("native login persists through /v1, isolates sessions and never enters the shared cache", async () => {
    expect((await send("/sessions", { id: "login" })).status).toBe(201)
    expect((await send("/v1", { cmd: "sessions.create", session: "separate" })).status).toBe(200)
    const login = await send("/scrape", {
      url: url("/login"),
      sessionId: "login",
      method: "POST",
      body: "user=fixture",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxTimeout: 15000,
    })
    expect(login.status, JSON.stringify(login.body)).toBe(200)
    expect(login.body.html).toContain('data-login="true"')
    expect(login.body.tier).toBe(3)
    expect(posts).toBe(1)
    const compat = await send("/v1", {
      cmd: "request.get",
      url: url("/account"),
      session: "login",
      maxTimeout: 15000,
      proxy: "http://127.0.0.1:1",
    })
    expect(compat.status, JSON.stringify(compat.body)).toBe(200)
    expect(compat.body.solution.response).toContain('data-login="true"')
    expect(compat.body.solution.userAgent).toBe(login.body.userAgent)
    const isolated = await send("/scrape", { url: url("/account"), sessionId: "separate", maxTimeout: 15000 })
    expect(isolated.status, JSON.stringify(isolated.body)).toBe(200)
    expect(isolated.body.html).toContain('data-login="false"')
    const ordinaryBrowser = await send("/scrape", {
      url: url("/account"),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: 15000,
    })
    expect(ordinaryBrowser.status, JSON.stringify(ordinaryBrowser.body)).toBe(200)
    expect(ordinaryBrowser.body.html).toContain('data-login="false"')
    const retained = await send("/scrape", { url: url("/account"), sessionId: "login", maxTimeout: 15000 })
    expect(retained.status).toBe(200)
    expect(retained.body.html).toContain('data-login="true"')
    expect(await getDeps().loadSession("127.0.0.1")).toBeUndefined()
    const ordinary = await send("/scrape", { url: url("/account") })
    expect(ordinary.status).toBe(200)
    expect(ordinary.body.html).toContain('data-login="false"')
    expect(getPool()?.getStats().available).toBe(1)

    const stored = await send("/scrape", { url: url("/storage"), sessionId: "login", maxTimeout: 15000 })
    expect(stored.status).toBe(200)
    const result = await send("/scrape", {
      url: url("/account"),
      sessionId: "login",
      screenshot: true,
      consoleLogs: true,
      networkLogs: true,
      maxTimeout: 15000,
    })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body.html).toContain('data-storage="retained"')
    expect(result.body.screenshot.length).toBeGreaterThan(100)
    expect(result.body.networkLogs.length).toBeGreaterThan(0)
    const budget = new RequestBudget(1000)
    try {
      await getDeps().sessions?.use("login", "", budget, async (_, context) => {
        expect(context.pages()).toHaveLength(0)
      })
    } finally {
      budget.dispose()
    }
    expect(getPool()?.getStats().available).toBe(1)

    const compatLogin = await send("/v1", {
      cmd: "request.post",
      url: url("/login"),
      session: "separate",
      postData: "user=fixture",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxTimeout: 15000,
    })
    expect(compatLogin.status, JSON.stringify(compatLogin.body)).toBe(200)
    expect(compatLogin.body.solution.response).toContain('data-login="true"')
    expect(posts).toBe(2)
    expect((await send("/v1", { cmd: "sessions.destroy", session: "separate" })).status).toBe(200)
    expect((await send("/scrape", { url: url("/account"), sessionId: "separate" })).status).toBe(404)
    expect((await send("/sessions/login", undefined, "DELETE")).status).toBe(200)
    expect((await send("/sessions")).body.sessions).toEqual([])
    expect(getPool()?.getStats().available).toBe(1)
  }, 100000)

  test("one persistent session survives repeated requests with no idle pages", async () => {
    expect((await send("/sessions", { id: "small" })).status).toBe(201)
    const initial = await send("/scrape", { url: url("/storage"), sessionId: "small", maxTimeout: 15000 })
    expect(initial.status, JSON.stringify(initial.body)).toBe(200)
    for (let i = 0; i < 3; i++) {
      const result = await send("/v1", {
        cmd: "request.get",
        session: "small",
        url: url("/account"),
        maxTimeout: 15000,
      })
      expect(result.status, JSON.stringify(result.body)).toBe(200)
      expect(result.body.solution.response).toContain('data-storage="retained"')
      expect(result.body.solution.response).toContain('data-tab-storage="retained"')
      expect(result.body.solution.userAgent).toBe(initial.body.userAgent)
      expect(getPool()?.getStats().available).toBe(1)
    }
    const cleared = await send("/scrape", {
      sessionId: "small",
      url: url("/logout-storage"),
      contentWaitForSelector: '[data-tab-storage="empty"]',
      maxTimeout: 15000,
    })
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(cleared.body.html).toContain('data-tab-storage="empty"')
    const next = await send("/scrape", { sessionId: "small", url: url("/account"), maxTimeout: 15000 })
    expect(next.status).toBe(200)
    expect(next.body.html).toContain('data-tab-storage="empty"')
    expect((await send("/sessions/small", undefined, "DELETE")).status).toBe(200)
  }, 65000)

  test("FlareSolverr implicit creation, cookie import, screenshots and age rotation", async () => {
    const imported = await send("/v1", {
      cmd: "request.get",
      session: "implicit",
      url: url("/account"),
      maxTimeout: 15000,
      cookies: [{ name: "fixture_login", value: "yes" }],
      returnScreenshot: true,
    })
    expect(imported.status, JSON.stringify(imported.body)).toBe(200)
    expect(imported.body.solution.response).toContain('data-login="true"')
    expect(imported.body.solution.screenshot.length).toBeGreaterThan(100)
    expect((await send("/v1", { cmd: "sessions.create", session: "implicit" })).status).toBe(200)
    const retained = await send("/v1", {
      cmd: "request.get",
      session: "implicit",
      url: url("/account"),
      maxTimeout: 15000,
    })
    expect(retained.status).toBe(200)
    expect(retained.body.solution.response).toContain('data-login="true"')
    const cookies = await send("/v1", {
      cmd: "request.get",
      session: "implicit",
      url: url("/account"),
      returnOnlyCookies: true,
      maxTimeout: 15000,
    })
    expect(cookies.status).toBe(200)
    expect(cookies.body.solution.response).toBeUndefined()
    expect(cookies.body.solution.cookies.some((cookie: { name: string }) => cookie.name === "fixture_login")).toBeTrue()
    const rotated = await send("/v1", {
      cmd: "request.get",
      session: "implicit",
      session_ttl_minutes: 0.00001,
      url: url("/account"),
      maxTimeout: 15000,
    })
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200)
    expect(rotated.body.solution.response).toContain('data-login="false"')
    expect((await send("/sessions/implicit", undefined, "DELETE")).status).toBe(200)
    const ordinary = await send("/v1", {
      cmd: "request.get",
      url: url("/account"),
      cookies: [{ name: "fixture_login", value: "yes" }],
      maxTimeout: 15000,
    })
    expect(ordinary.status).toBe(200)
    expect(ordinary.body.solution.response).toContain('data-login="true"')
    expect(await getDeps().loadSession("127.0.0.1")).toBeUndefined()
  }, 100000)

  test("a fixed session proxy actually carries requests and rejects native proxy overrides", async () => {
    let forwarded = 0
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const incoming = new URL(request.url)
        if (incoming.hostname !== "fixture.invalid") return new Response("Unexpected proxy target", { status: 502 })
        forwarded++
        return fetch(url(incoming.pathname), { headers: request.headers })
      },
    })
    try {
      expect(
        (
          await send("/v1", {
            cmd: "sessions.create",
            session: "proxy",
            proxy: { url: `http://127.0.0.1:${proxy.port}` },
          })
        ).status,
      ).toBe(200)
      const result = await send("/scrape", {
        url: `http://fixture.invalid:${fixture.port}/account`,
        sessionId: "proxy",
        maxTimeout: 15000,
      })
      expect(result.status, JSON.stringify(result.body)).toBe(200)
      expect(result.body.html).toContain("Owned account fixture")
      expect(result.body.proxyUsed).toBeTrue()
      expect(forwarded).toBeGreaterThan(0)
      const before = forwarded
      expect(
        (await send("/scrape", { url: url("/account"), sessionId: "proxy", proxy: "http://other.invalid:8080" }))
          .status,
      ).toBe(400)
      expect(forwarded).toBe(before)
      expect((await send("/sessions/proxy", undefined, "DELETE")).status).toBe(200)
    } finally {
      proxy.stop(true)
    }
  }, 25000)

  test("browser loss invalidates sessions and the pool can create a new session", async () => {
    expect((await send("/sessions", { id: "crash" })).status).toBe(201)
    const budget = new RequestBudget(1000)
    try {
      await getDeps().sessions?.use("crash", "", budget, async (handle) => {
        await handle.browser.close()
      })
    } finally {
      budget.dispose()
    }
    expect((await send("/sessions")).body.sessions).toEqual([])
    expect((await send("/sessions", { id: "recovered" })).status).toBe(201)
    expect((await send("/sessions/recovered", undefined, "DELETE")).status).toBe(200)
    expect(getPool()?.getStats().available).toBe(1)
  }, 30000)

  test("deadline invalidates the context, releases capacity and allows ordinary scraping", async () => {
    expect((await send("/sessions", { id: "timeout" })).status).toBe(201)
    const timedOut = await send("/scrape", { url: url("/slow"), sessionId: "timeout", maxTimeout: 150 })
    expect(timedOut.status).toBe(500)
    const deadline = Date.now() + 10000
    while (!getPool()?.getStats().available && Date.now() < deadline) await Bun.sleep(20)
    expect((await send("/sessions")).body.sessions).toEqual([])
    expect(getPool()?.getStats().available).toBe(1)
    expect((await send("/scrape", { url: url("/account") })).status).toBe(200)
  }, 15000)
})
