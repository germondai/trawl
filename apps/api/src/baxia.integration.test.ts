import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { type BrowserHandle, MemorySessionCache } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import type { TierResult } from "@trawl/types"
import { Elysia } from "elysia"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

describe.skipIf(process.env.TRAWL_BAXIA_TESTS !== "1")("Baxia access walls", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let origin: ReturnType<typeof Bun.serve>
  let handle: BrowserHandle
  const cache = new MemorySessionCache({ ttlSeconds: 60 })
  const metrics = new MetricsStore()
  const attempts: TierResult[] = []
  const verified = new Map<string, number>()
  const submissions = new Map<string, number>()
  const retryClicks = new Map<string, number>()
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => handle,
    releaseBrowser() {},
    loadSession: (domain) => cache.load(domain),
    saveSession: (domain, session) => cache.save(domain, session),
    invalidateSession: (domain) => cache.invalidate(domain),
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
    .use(v1Route({ orchestratorDeps: () => deps, poolReady: () => true, metricsStore: metrics, cookieFallback: false }))
  const content = `<html><body><h1>Owned protected content</h1><p>${"Complete destination. ".repeat(30)}</p></body></html>`

  beforeAll(async () => {
    origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const id = url.searchParams.get("id") ?? ""
        const mode = url.searchParams.get("mode") ?? "accept"
        if (url.pathname === "/retry-click") {
          retryClicks.set(id, (retryClicks.get(id) ?? 0) + 1)
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/verify") {
          submissions.set(id, (submissions.get(id) ?? 0) + 1)
          const { down, up, distance } = await request.json()
          const pass = down && up && distance >= 245 && !["reject", "retry-redirect"].includes(mode)
          if (pass) verified.set(id, (verified.get(id) ?? 0) + 1)
          return Response.json({ pass }, { headers: pass ? { "set-cookie": `x5sec=owned-${id}; Path=/` } : {} })
        }
        if (url.pathname === "/content" && request.headers.get("cookie")?.includes(`x5sec=owned-${id}`))
          return new Response(content, { headers: { "content-type": "text/html" } })
        if (mode === "redirect-embedded")
          return new Response(
            `<html><body><a href="/_____tmd_____/punish?x5secdata=owned">Challenge</a>
              <script>setTimeout(()=>location.replace('/wall?id=${id}&mode=embedded'),${Number(url.searchParams.get("delay") ?? 100)})</script></body></html>`,
            { headers: { "content-type": "text/html", bxpunish: "1" } },
          )
        const widget = `<div id="nc_1_n1t" style="position:relative;margin:50px;width:300px;height:40px;background:#ddd">
          <div id="nc_1_n1z" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#888">&gt;</div></div>
          <script>
          const knob=document.querySelector('#nc_1_n1z');let held=false,start=0,distance=0,down=false;
          knob.onmousedown=e=>{held=true;start=e.clientX;down=e.isTrusted;};
          window.onmousemove=e=>{if(held){distance=e.clientX-start;knob.style.left=Math.max(0,Math.min(260,distance))+'px';}};
          window.onmouseup=async e=>{if(!held)return;held=false;
            const result=await fetch('/verify?id=${id}&mode=${mode}',{method:'POST',headers:{'content-type':'application/json'},
              body:JSON.stringify({distance,down,up:e.isTrusted})}).then(r=>r.json());
            if(result.pass)setTimeout(()=>top.location.replace('/content?id=${id}'),${mode === "delayed" ? 300 : 0});
          };
          </script>`
        const redirect = ["drag-redirect", "press-redirect", "frame-redirect"].includes(mode)
          ? `<script>window.addEventListener('${mode === "press-redirect" ? "mousedown" : "mousemove"}', event => {
              if(event.isTrusted) location.replace('/wall?id=${id}&mode=embedded');
            }, {once:true});</script>`
          : ""
        if (url.pathname === "/widget")
          return new Response(`<html><body>${widget}${redirect}</body></html>`, {
            headers: { "content-type": "text/html" },
          })
        const retry = ["retry-redirect", "embedded"].includes(mode)
          ? `<button id="nc_1_refresh1" style="position:absolute;left:400px;top:40px"
              onmouseover="${mode === "retry-redirect" ? `location.replace('/wall?id=${id}&mode=embedded')` : ""}"
              onclick="fetch('/retry-click?id=${id}')">Retry</button>`
          : ""
        return new Response(
          `<html><body><h1>Owned NC fixture</h1>
          ${mode === "embedded" ? "<span>Optional widget</span>" : '<a href="/_____tmd_____/punish?x5secdata=owned">Baxia challenge</a>'}
          ${mode.startsWith("frame-") ? `<iframe src="/widget?id=${id}&mode=${mode}" style="width:500px;height:250px;border:0"></iframe>` : mode === "missing" ? "" : widget}
          ${mode.startsWith("frame-") ? "" : redirect}${retry}</body></html>`,
          { headers: { "content-type": "text/html", ...(mode === "embedded" ? {} : { bxpunish: "1" }) } },
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

  beforeEach(async () => {
    cache.close()
    await handle.context.clearCookies()
    attempts.length = 0
  })

  afterAll(async () => {
    await browser?.close()
    origin?.stop(true)
    cache.close()
    metrics.close()
  })

  const seedCache = () =>
    cache.save("127.0.0.1", {
      cookies: [
        {
          name: "x5sec",
          value: "stale",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      userAgent: handle.fingerprint.userAgent,
      savedAt: Date.now(),
    })
  async function send(route: string, mode = "accept", delay = 100) {
    const id = crypto.randomUUID()
    const response = await app.handle(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cmd: "request.get",
          url: `${origin.url}wall?id=${id}&mode=${mode}&delay=${delay}`,
          maxTimeout: 20000,
          ...(route === "/scrape" ? { solveEmbeddedCaptchas: false } : {}),
          ...(mode === "embedded" ? { skipHttp: true, cookies: [{ name: "owned-optout", value: "fixture" }] } : {}),
        }),
      }),
    )
    return { response, body: await response.json(), id }
  }

  for (const route of ["/scrape", "/v1"]) {
    for (const cached of [false, true]) {
      test(`${route} solves an access wall with embedded solving disabled, cached=${cached}`, async () => {
        if (cached) await seedCache()
        const { response, body, id } = await send(route)
        expect(response.status, JSON.stringify(body)).toBe(200)
        expect(route === "/scrape" ? body.html : body.solution.response).toContain("Owned protected content")
        expect(verified.get(id)).toBe(1)
        expect(submissions.get(id)).toBe(1)
        expect(attempts.flatMap((a) => a.captchas ?? [])).toEqual([{ kind: "baxia-nc", outcome: "solved" }])
        if (cached) expect(attempts.some((a) => a.tier === 2 && a.status === "success")).toBe(false)
        expect(browser.contexts()).toHaveLength(1)
      }, 30000)
    }

    test.each(["missing", "reject"])(
      `${route} never returns a cached %s wall as success`,
      async (mode) => {
        await seedCache()
        const { response, body, id } = await send(route, mode)
        expect(response.status, JSON.stringify(body)).toBe(500)
        expect(JSON.stringify(body)).toContain("baxia-persistent")
        if (route === "/v1") expect(body.status).toBe("error")
        expect(verified.get(id) ?? 0).toBe(0)
        expect(attempts.some((a) => a.tier === 2 && a.status === "blocked")).toBe(true)
        expect(await cache.load("127.0.0.1")).toBeUndefined()
        expect(browser.contexts()).toHaveLength(1)
      },
      30000,
    )

    test(`${route} preserves the opt-out for an embedded NC widget on an ordinary page`, async () => {
      const { response, body, id } = await send(route, "embedded")
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(route === "/scrape" ? body.html : body.solution.response).toContain("Owned NC fixture")
      expect(submissions.get(id) ?? 0).toBe(0)
      expect(attempts.flatMap((a) => a.captchas ?? [])).toEqual([])
    }, 30000)
  }

  test("/v1 waits for navigation after the widget issues its cookie", async () => {
    const { response, body, id } = await send("/v1", "delayed")
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.solution.response).toContain("Owned protected content")
    expect(verified.get(id)).toBe(1)
  }, 30000)

  test.each(["drag-redirect", "press-redirect"])(
    "/v1 stops interacting after navigation during %s",
    async (mode) => {
      const { response, body, id } = await send("/v1", mode)
      expect(submissions.get(id) ?? 0).toBe(0)
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.solution.response).toContain("Optional widget")
      expect(attempts.flatMap((a) => a.captchas ?? [])).toEqual([{ kind: "baxia-nc", outcome: "failed" }])
    },
    30000,
  )

  test("/v1 solves a wall whose widget is in an iframe", async () => {
    const { response, body, id } = await send("/v1", "frame-accept")
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.solution.response).toContain("Owned protected content")
    expect(verified.get(id)).toBe(1)
    expect(submissions.get(id)).toBe(1)
  }, 30000)

  test("/v1 stops interacting after the widget iframe navigates", async () => {
    const { response, body, id } = await send("/v1", "frame-redirect")
    expect(response.status, JSON.stringify(body)).toBe(500)
    expect(JSON.stringify(body)).toContain("baxia-persistent")
    expect(submissions.get(id) ?? 0).toBe(0)
  }, 30000)

  test("/v1 never retries a matching control in the destination document", async () => {
    const { response, body, id } = await send("/v1", "retry-redirect")
    expect(retryClicks.get(id) ?? 0).toBe(0)
    expect(submissions.get(id)).toBe(1)
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.solution.response).toContain("Optional widget")
  }, 30000)

  test.each([100, 1000])(
    "/v1 preserves the opt-out after navigation away from an access wall after %sms",
    async (delay) => {
      const { response, body, id } = await send("/v1", "redirect-embedded", delay)
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.solution.response).toContain("Owned NC fixture")
      expect(submissions.get(id) ?? 0).toBe(0)
      expect(attempts.flatMap((a) => a.captchas ?? [])).toEqual([])
    },
    30000,
  )
})
