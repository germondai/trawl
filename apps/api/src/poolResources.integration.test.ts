import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { newFreshContext } from "@trawl/browser"
import { solveCap } from "../../../packages/tiers/src/solvers/cap"
import { createApiApp } from "./app"
import { getPool, initPool, shutdownPools } from "./deps"

// Owned fixtures and real Camoufox; run explicitly in a memory-limited container.
describe.skipIf(process.env.TRAWL_POOL_RESOURCE_TESTS !== "1")("API browser resource integration", () => {
  let fixture: ReturnType<typeof Bun.serve>
  let app: ReturnType<typeof createApiApp>
  let origin: string
  const body = `<html><head><title>Fixture</title></head><body>${"Verified destination ".repeat(30)}</body></html>`
  const url = (path: string) => `http://127.0.0.1:${fixture.port}${path}`
  const post = (route: string, payload: unknown) =>
    fetch(origin + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  const ready = async () => {
    const pool = getPool()
    if (!pool) throw new Error("pool not initialized")
    const deadline = Date.now() + 20000
    while (!pool.getStats().available && Date.now() < deadline) await Bun.sleep(20)
    expect(pool.getStats().available).toBe(1)
    return pool
  }

  beforeAll(async () => {
    fixture = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/clearance-issue")
          return new Response(body, {
            headers: { "content-type": "text/html", "set-cookie": "cf_clearance=owned-clearance; Path=/; HttpOnly" },
          })
        if (path === "/clearance-required" && !request.headers.get("cookie")?.includes("cf_clearance=owned-clearance"))
          return new Response(
            "<html><title>Just a moment...</title><body id=challenge-form>Clearance required</body></html>",
            {
              status: 403,
              headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
            },
          )
        if (path === "/akamai-clear" && !request.headers.get("cookie")?.includes("_abck="))
          return new Response(
            '<html><body><div id="sec-if-cpt-container" class="behavioral-content"><button id="progress-button">Press and hold</button></div><script>setTimeout(() => { document.cookie = "_abck=fixture~0~accepted; Path=/"; location.reload() }, 1200)</script></body></html>',
            { status: 403, headers: { "content-type": "text/html" } },
          )
        if (path === "/unresolved-widget")
          return new Response(
            body.replace(
              "</body>",
              '<div class="cf-turnstile"></div><input type="hidden" name="cf-turnstile-response" value=""></body>',
            ),
            { headers: { "content-type": "text/html" } },
          )
        if (path === "/embedded-turnstile")
          return new Response(
            '<html><head><title>Contact form</title></head><body><form><div class="cf-turnstile"><iframe src="/cdn-cgi/challenge-platform/turnstile" width="300" height="65"></iframe></div><input name="cf-turnstile-response" type="hidden"><button type="submit">Submit form</button></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.body.dataset.submitted="true"};window.addEventListener("message",e=>{if(e.origin===location.origin && e.data==="owned-fixture-solved")document.querySelector("input").value="owned-fixture-response-not-a-vendor-token"})</script></body></html>',
            { headers: { "content-type": "text/html" } },
          )
        if (path === "/cdn-cgi/challenge-platform/turnstile")
          return new Response(
            '<html><body><button role="checkbox" onclick="parent.postMessage(\'owned-fixture-solved\',location.origin)">Verify</button></body></html>',
            { headers: { "content-type": "text/html" } },
          )
        if (path === "/cap-token" || path === "/cap-empty" || path === "/cap-multiple" || path === "/cap-partial")
          return new Response(
            `<html><body><form><cap-widget style="display:block;margin-top:2000px" data-cap-hidden-field-name="verification"></cap-widget>${path === "/cap-multiple" || path === "/cap-partial" ? `<cap-widget style="display:block" data-cap-hidden-field-name="verification" ${path === "/cap-partial" ? "data-reject" : ""}></cap-widget>` : ""}<button type="submit">Submit form</button></form><script>
            document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.submitted='true'};
            customElements.define('cap-widget',class extends HTMLElement {
              connectedCallback(){
                this.innerHTML='<input type="hidden" name="verification">';
                this.attachShadow({mode:'open'}).innerHTML='<button class="captcha-trigger">Verify</button>';
                this.shadowRoot.querySelector('button').onclick=()=>{
                  this.shadowRoot.querySelector('button').textContent="You're a human";
                  this.querySelector('input').value=this.hasAttribute('data-reject') ? '' : ${JSON.stringify(path !== "/cap-empty" ? "owned-cap-fixture-response" : "")};
                };
              }
            });</script></body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        if (path === "/stall") return new Promise<Response>(() => {})
        if (path === "/cf-navigation")
          return new Response(
            '<html><head><title>Just a moment...</title></head><body id="challenge-form"><script>setTimeout(() => location.replace("/final"), 400)</script></body></html>',
            { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } },
          )
        if (path === "/cookie")
          return new Response(body, {
            headers: { "content-type": "text/html", "set-cookie": "fixture_session=accepted; Path=/; HttpOnly" },
          })
        if (path === "/cookie-required" && !request.headers.get("cookie")?.includes("fixture_session=accepted")) {
          return new Response("<html><head><title>Just a moment</title></head><body>Cookie required</body></html>", {
            status: 403,
            headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
          })
        }
        if (path === "/start")
          return new Response(
            '<html><head><meta http-equiv="refresh" content="1; url=/final"></head><body>Redirect</body></html>',
            { headers: { "content-type": "text/html" } },
          )
        if (path === "/challenge")
          return new Response(
            `<html><head><title>Just a moment</title></head><body><script>setTimeout(() => { document.title = 'Fixture'; document.body.textContent = 'Verified destination '.repeat(30) }, 100)</script></body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        return new Response(body, { headers: { "content-type": "text/html" } })
      },
    })
    await initPool({ poolSize: 1, headfulPoolSize: 0 })
    app = createApiApp().listen(0)
    origin = `http://127.0.0.1:${app.server?.port}`
  }, 120000)

  afterAll(async () => {
    await app?.stop()
    await shutdownPools()
    fixture?.stop(true)
  })

  test("Akamai automatic cookie reload returns content through native and v1 routes", async () => {
    for (const route of ["/scrape", "/v1"]) {
      const response = await post(
        route,
        route === "/v1"
          ? { cmd: "request.get", url: url("/akamai-clear"), maxTimeout: 10000 }
          : { url: url("/akamai-clear"), skipHttp: true, maxTier: 3, maxTimeout: 10000 },
      )
      const result = (await response.json()) as { html?: string; solution?: { response: string } }
      expect(response.status, JSON.stringify(result)).toBe(200)
      expect(result.html ?? result.solution?.response).toContain("Verified destination")
      await ready()
    }
  }, 30000)

  test("embedded Turnstile confirms its fixture token without submitting a form", async () => {
    const response = await post("/scrape", {
      url: url("/embedded-turnstile"),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: 15000,
    })
    const result = (await response.json()) as { html: string; captchasSolved?: string[] }
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.captchasSolved).toContain("turnstile")
    expect(result.html).toContain("owned-fixture-response-not-a-vendor-token")
    expect(result.html).not.toContain('data-submitted="true"')
    await ready()
  }, 20000)

  test("page delivery skips optional widgets without skipping access challenges", async () => {
    for (const route of ["/scrape", "/v1"]) {
      const start = performance.now()
      const response = await post(route, {
        url: url("/unresolved-widget"),
        maxTimeout: 10000,
        ...(route === "/scrape" ? { skipHttp: true, solveEmbeddedCaptchas: false } : { cmd: "request.get" }),
      })
      const result = (await response.json()) as {
        html?: string
        captchasSolved?: string[]
        solution?: { response: string }
      }
      expect(response.status, JSON.stringify(result)).toBe(200)
      expect(result.html ?? result.solution?.response).toContain("Verified destination")
      expect(result.html ?? result.solution?.response).not.toContain("owned-fixture-response")
      expect(result.captchasSolved ?? []).toEqual([])
      expect(performance.now() - start).toBeLessThan(5000)
      await ready()
    }
    const response = await post("/v1", { cmd: "request.get", url: url("/cf-navigation"), maxTimeout: 10000 })
    const result = (await response.json()) as { solution: { response: string; url: string; status: number } }
    expect(response.status).toBe(200)
    expect(result.solution.url).toBe(url("/final"))
    expect(result.solution.status).toBe(200)
    expect(result.solution.response).toContain("Verified destination")
    await ready()
  }, 30000)

  test("an unsolved embedded widget leaves time to return native page content", async () => {
    const bootstrap = await post("/scrape", { url: url("/clearance-issue"), skipHttp: true, maxTimeout: 15000 })
    expect(bootstrap.status).toBe(200)
    for (const tier of [3, 2]) {
      const response = await post("/scrape", {
        url: url("/unresolved-widget"),
        skipHttp: true,
        maxTimeout: 9000,
        maxTier: tier,
        ...(tier === 3 ? { cookies: [{ name: "fixture", value: "fresh" }] } : {}),
      })
      const result = (await response.json()) as { tier: number; html: string; captchasSolved?: string[] }
      expect(response.status, JSON.stringify(result)).toBe(200)
      expect(result.tier).toBe(tier)
      expect(result.html).toContain("Verified destination")
      expect(result.captchasSolved ?? []).toEqual([])
      await ready()
    }
  }, 30000)

  test("v1 can explicitly solve an embedded widget", async () => {
    const response = await post("/v1", {
      cmd: "request.get",
      url: url("/embedded-turnstile"),
      solveEmbeddedCaptchas: true,
      maxTimeout: 15000,
    })
    const result = (await response.json()) as { solution: { response: string } }
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.solution.response).toContain("owned-fixture-response-not-a-vendor-token")
    await ready()
  }, 20000)

  test("CAP accepts its response field but rejects a success label with no token", async () => {
    const pool = await ready()
    const lease = await pool.acquire()
    const context = await newFreshContext(lease.browser)
    try {
      const page = await context.newPage()
      for (const path of ["/cap-token", "/cap-empty"]) {
        await page.goto(url(path), { waitUntil: "domcontentloaded" })
        expect(await solveCap(page, 4000)).toBe(path === "/cap-token")
        expect(await page.evaluate(() => document.body.dataset.submitted === "true")).toBe(false)
      }
    } finally {
      await context.close()
      pool.release(lease.id, lease.lease)
    }
    await ready()
  }, 15000)

  test("CAP confirms every visible widget before reporting completion", async () => {
    const pool = await ready()
    const lease = await pool.acquire()
    const context = await newFreshContext(lease.browser)
    try {
      const page = await context.newPage()
      for (const path of ["/cap-multiple", "/cap-partial"]) {
        await page.goto(url(path), { waitUntil: "domcontentloaded" })
        expect(await solveCap(page, 5000)).toBe(path === "/cap-multiple")
        const completed = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLInputElement>("cap-widget input")).map((el) => Boolean(el.value)),
        )
        expect(completed).toEqual([true, path === "/cap-multiple"])
        expect(await page.evaluate(() => document.body.dataset.submitted === "true")).toBe(false)
      }
    } finally {
      await context.close()
      pool.release(lease.id, lease.lease)
    }
    await ready()
  }, 15000)

  test("native requests cross the recycle threshold and retain a usable pool", async () => {
    for (let i = 0; i < 12; i++) {
      const response = await post("/scrape", {
        url: url(i % 3 === 0 ? "/start" : "/final"),
        skipHttp: true,
        cookies: [{ name: "fixture", value: "recycle" }],
        followMetaRefresh: true,
        maxTier: 3,
        maxTimeout: 15000,
      })
      const result = (await response.json()) as { html: string; tier: number }
      expect(response.status, JSON.stringify(result)).toBe(200)
      expect(result.html).toContain("Verified destination")
      expect(result.tier).toBe(3)
    }
    await ready()
    expect(getPool()?.getStats().restarts).toBeGreaterThan(0)
    const health = await fetch(`${origin}/health`)
    expect(health.status).toBe(200)
    const diagnostics = (await health.json()) as { memory?: { oomKills: number } }
    expect(diagnostics.memory?.oomKills).toBe(0)
  }, 120000)

  test("an expired navigation closes its context and leaves the next request usable", async () => {
    await ready()
    const start = performance.now()
    const response = await post("/scrape", { url: url("/stall"), skipHttp: true, maxTier: 3, maxTimeout: 500 })
    expect(response.status).not.toBe(200)
    expect(performance.now() - start).toBeLessThan(6500)
    const pool = await ready()
    expect(pool.getStats().busy).toBe(0)
    expect(pool.getStats().queueDepth).toBe(0)
    const next = await post("/scrape", { url: url("/final"), skipHttp: true, maxTier: 3, maxTimeout: 15000 })
    expect(next.status).toBe(200)
    expect(((await next.json()) as { html: string }).html).toContain("Verified destination")
  }, 30000)

  test("Cloudflare navigation drops stale challenge headers for native and /v1 requests", async () => {
    for (const route of ["/scrape", "/v1"]) {
      await ready()
      const response = await post(route, {
        cmd: "request.get",
        url: url("/cf-navigation"),
        skipHttp: true,
        minTier: 3,
        maxTimeout: 5000,
      })
      const result = (await response.json()) as { html?: string; solution?: { response: string } }
      expect(response.status, JSON.stringify(result)).toBe(200)
      expect(result.html ?? result.solution?.response).toContain("Verified destination")
    }
    const pool = await ready()
    expect(pool.getStats().busy).toBe(0)
  }, 20000)

  test("native and FlareSolverr queues honor short request budgets", async () => {
    const pool = await ready()
    const held = await pool.acquire()
    try {
      for (const route of ["/scrape", "/v1"]) {
        const start = performance.now()
        const response = await post(route, { url: url("/challenge"), skipHttp: true, maxTimeout: 80 })
        expect(response.status).toBe(429)
        expect(performance.now() - start).toBeLessThan(500)
        expect(pool.getStats().queueDepth).toBe(0)
      }
    } finally {
      pool.release(held.id, held.lease)
    }
  }, 10000)

  test("a closed retained context recovers even while the browser transport stays connected", async () => {
    const pool = await ready()
    const restarts = pool.getStats().restarts
    const held = await pool.acquire()
    await held.context.close()
    pool.release(held.id, held.lease)
    const response = await post("/scrape", { url: url("/final"), skipHttp: true, maxTimeout: 15000 })
    const result = (await response.json()) as { html: string }
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.html).toContain("Verified destination")
    expect(pool.getStats().restarts).toBeGreaterThan(restarts)
    await ready()
  }, 30000)

  test("a browser disconnect recovers before the next health tick and serves /v1", async () => {
    const pool = await ready()
    const previousRestarts = pool.getStats().restarts
    const held = await pool.acquire()
    await held.browser.close()
    pool.release(held.id, held.lease)
    const response = await post("/v1", { url: url("/challenge"), maxTimeout: 15000 })
    const result = (await response.json()) as { status: string; solution: { response: string } }
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.status).toBe("ok")
    expect(result.solution.response).toContain("Verified destination")
    expect(pool.getStats().restarts).toBeGreaterThan(previousRestarts)
    await ready()
    const bootstrap = await post("/scrape", { url: url("/cookie"), skipHttp: true, minTier: 3, maxTimeout: 15000 })
    expect(bootstrap.status).toBe(200)
    await ready()
    const lease = await pool.acquire()
    lease.requestBrowserReplacement?.("fixture cookie recovery")
    pool.release(lease.id, lease.lease)
    await ready()
    const cached = await post("/scrape", {
      url: url("/cookie-required"),
      skipHttp: true,
      maxTier: 2,
      maxTimeout: 15000,
    })
    const cacheResult = (await cached.json()) as { html: string; tier: number }
    expect(cached.status, JSON.stringify(cacheResult)).toBe(200)
    expect(cacheResult.tier).toBe(2)
    expect(cacheResult.html).toContain("Verified destination")
    const compatible = await post("/v1", { url: url("/cookie-required"), maxTimeout: 15000 })
    expect(compatible.status).toBe(200)
    const compatibleResult = (await compatible.json()) as { solution: { response: string } }
    expect(compatibleResult.solution.response).toContain("Verified destination")
  }, 30000)
  test("native and /v1 reuse browser clearance through HTTP while browser outputs and widgets still execute", async () => {
    const bootstrap = await post("/scrape", { url: url("/clearance-issue"), skipHttp: true, maxTimeout: 15000 })
    expect(bootstrap.status).toBe(200)
    const initial = (await bootstrap.json()) as { userAgent: string }
    const cached = await post("/scrape", { url: url("/clearance-required"), maxTier: 1, maxTimeout: 10000 })
    const result = (await cached.json()) as { tier: number; sessionCached: boolean; html: string; userAgent: string }
    expect(cached.status, JSON.stringify(result)).toBe(200)
    expect(result).toMatchObject({ tier: 1, sessionCached: true, userAgent: initial.userAgent })
    expect(result.html).toContain("Verified destination")

    const compatible = await post("/v1", { cmd: "request.get", url: url("/clearance-required"), maxTimeout: 10000 })
    const v1 = (await compatible.json()) as {
      status: string
      solution: { response: string; cookies: { name: string; value: string }[]; userAgent: string }
    }
    expect(compatible.status).toBe(200)
    expect(v1.status).toBe("ok")
    expect(v1.solution.response).toContain("Verified destination")
    expect(v1.solution.cookies).toContainEqual(
      expect.objectContaining({ name: "cf_clearance", value: "owned-clearance" }),
    )
    expect(v1.solution.userAgent).toBe(initial.userAgent)

    const screenshot = await post("/scrape", {
      url: url("/clearance-required"),
      screenshot: true,
      maxTier: 2,
      maxTimeout: 10000,
    })
    const captured = (await screenshot.json()) as { tier: number; screenshot: string }
    expect(screenshot.status).toBe(200)
    expect(captured.tier).toBe(2)
    expect(captured.screenshot.length).toBeGreaterThan(100)

    const widget = await post("/scrape", { url: url("/embedded-turnstile"), maxTier: 2, maxTimeout: 15000 })
    const solved = (await widget.json()) as { tier: number; html: string; captchasSolved: string[] }
    expect(widget.status, JSON.stringify(solved)).toBe(200)
    expect(solved.tier).toBe(2)
    expect(solved.captchasSolved).toContain("turnstile")
    expect(solved.html).toContain("owned-fixture-response-not-a-vendor-token")
    expect((await ready()).getStats().busy).toBe(0)
  }, 45000)
})
