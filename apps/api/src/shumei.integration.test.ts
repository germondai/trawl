import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { type OrchestratorDeps, ProxyPool } from "@trawl/tiers"
import { Elysia } from "elysia"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import { solvePageCaptchas } from "../../../packages/tiers/src/solvers"
import { solveShumei } from "../../../packages/tiers/src/solvers/shumei"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

describe.skipIf(process.env.TRAWL_SHUMEI_TESTS !== "1")("Shumei browser integration", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let server: ReturnType<typeof Bun.serve>
  let proxy: ReturnType<typeof Bun.serve>
  let handle: BrowserHandle
  const metrics = new MetricsStore()
  const agents = new Map<string, { agent: string; origin: string }>()
  const verified = new Map<string, number>()
  const submissions = new Map<string, number>()
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => handle,
    releaseBrowser() {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  const target = (mode = "accept", proxied = false) =>
    `http://${proxied ? "shumei-fixture.invalid" : "127.0.0.1"}:${server.port}/${mode}?id=${crypto.randomUUID()}`

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/puzzle.svg") {
          const x = url.searchParams.get("version") === "2" ? 110 : 60
          return new Response(
            `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150">
            <rect width="300" height="150" fill="white"/>
            <rect x="${x}" y="30" width="24" height="24" fill="red"/>
            <rect x="180" y="60" width="50" height="50" fill="red"/>
            <rect x="250" y="20" width="20" height="20" fill="green"/>
          </svg>`,
            { headers: { "content-type": "image/svg+xml" } },
          )
        }
        if (url.pathname === "/verify") {
          const { x, y, id, mode, version, trusted } = await request.json()
          submissions.set(id, (submissions.get(id) ?? 0) + 1)
          const identity = agents.get(id)
          const wantedX = version === 2 ? 122 : 72
          const pass =
            identity &&
            trusted &&
            mode !== "deny" &&
            mode !== "closed" &&
            !(mode === "refresh" && version === 1) &&
            Math.abs(x - wantedX) < 8 &&
            Math.abs(y - 42) < 8 &&
            request.headers.get("cookie")?.includes(`owned=${id}`) &&
            request.headers.get("user-agent") === identity.agent &&
            request.headers.get("origin") === identity.origin
          if (mode === "stall") await Bun.sleep(2000)
          if (pass) verified.set(id, (verified.get(id) ?? 0) + 1)
          return Response.json({ pass: Boolean(pass), rid: pass ? `owned-${id}` : undefined })
        }
        const mode = url.pathname.slice(1)
        const id = url.searchParams.get("id") ?? ""
        if (!id) return new Response(null, { status: 404 })
        agents.set(id, {
          agent: request.headers.get("user-agent") ?? "",
          origin: request.headers.get("x-fixture-origin") ?? url.origin,
        })
        const widget = `<div id="owned-widget" class="shumei_captcha_wrapper mode-${mode === "unsupported" ? "select" : "spatial_select"}">
          <img class="shumei_captcha_loaded_img_bg" src="/puzzle.svg" width="${mode === "oversized" ? 1200 : 300}" height="${mode === "oversized" ? 600 : 150}">
          <div class="shumei_captcha_slide_wrapper"><div class="shumei_captcha_slide_tips">点击图中最小的红色物体</div></div>
        </div>`
        return new Response(
          `<html><body><h1>Owned Shumei fixture</h1><p>${"Protected widget content. ".repeat(8)}</p>
          ${mode === "refresh" ? '<div style="height:1200px"></div>' : ""}
          <form>${mode === "delayed" ? widget.replace("mode-spatial_select", "").replace('id="owned-widget"', 'id="owned-widget" style="display:none"') : widget}<input type="hidden" class="shumei_captcha_input_rid" name="rid"></form>
          ${mode === "multiple" ? widget.replace('id="owned-widget"', 'id="other-widget"') : ""}
          <p id="status">waiting</p><script>
          const mode = ${JSON.stringify(mode)}, id = ${JSON.stringify(id)};
          const root = document.querySelector('#owned-widget'), img = root.querySelector('img');
          let version = 1;
          function initSMCaptcha() {}
          initSMCaptcha();
          if (mode === 'delayed') setTimeout(() => { root.classList.add('mode-spatial_select'); root.style.display = ''; }, 250);
          img.addEventListener('click', async (event) => {
            const box = img.getBoundingClientRect();
            const result = await fetch('/verify', { method: 'POST', headers: {'content-type':'application/json'},
              body: JSON.stringify({x:(event.clientX-box.x)*300/box.width,y:(event.clientY-box.y)*150/box.height,
                mode,id,version,trusted:event.isTrusted}) }).then(r=>r.json());
            if (result.pass) {
              root.querySelector('.shumei_captcha_slide_wrapper').classList.add('select_success');
              document.querySelector('[name=rid]').value = result.rid;
              document.querySelector('#status').textContent = 'accepted';
            } else if (mode === 'refresh' && version === 1) {
              version = 2; img.src = '/puzzle.svg?version=2';
            } else {
              root.style.display = 'none'; document.querySelector('#status').textContent = 'rejected';
            }
          });
          </script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": `owned=${id}; Path=/` } },
        )
      },
    })
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.hostname !== "shumei-fixture.invalid") return new Response("Unexpected target", { status: 502 })
        const headers = new Headers(request.headers)
        headers.set("x-fixture-origin", url.origin)
        headers.delete("host")
        url.hostname = "127.0.0.1"
        return fetch(url, {
          method: request.method,
          headers,
          body: request.method === "POST" ? await request.arrayBuffer() : undefined,
        })
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
    server?.stop(true)
    proxy?.stop(true)
    metrics.close()
  })

  test.each(["deny", "closed", "unsupported", "oversized", "multiple"])(
    "never reports %s as solved",
    async (mode) => {
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        const url = target(mode)
        await page.goto(url)
        expect(await solveShumei(page as never, 1500)).toBe(false)
        expect(await page.locator('[name="rid"]').inputValue()).toBe("")
        if (mode === "deny" || mode === "closed")
          expect(submissions.get(new URL(url).searchParams.get("id") ?? "")).toBe(1)
      } finally {
        await context.close()
      }
    },
    10000,
  )

  test("waits for a partially initialized SDK widget to become visible", async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(target("delayed"))
      expect(await solvePageCaptchas(page as never, 3000)).toEqual({ attempted: ["shumei"], solved: ["shumei"] })
      expect(await page.locator("#status").textContent()).toBe("accepted")
    } finally {
      await context.close()
    }
  }, 10000)

  test("recalculates the click when the SDK replaces a rejected image", async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(target("refresh"))
      expect(await solvePageCaptchas(page as never, 4000)).toEqual({ attempted: ["shumei"], solved: ["shumei"] })
      expect(await page.locator("#status").textContent()).toBe("accepted")
    } finally {
      await context.close()
    }
  }, 10000)

  test("stops waiting for verification when cancelled", async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(target("stall"))
      const start = Date.now()
      expect(await solveShumei(page as never, 5000, AbortSignal.timeout(150))).toBe(false)
      expect(Date.now() - start).toBeLessThan(1500)
      expect(await page.locator('[name="rid"]').inputValue()).toBe("")
    } finally {
      await context.close()
    }
  }, 10000)

  for (const route of ["/scrape", "/v1"]) {
    test.each([false, true])(
      `${route} preserves browser identity and cookies with proxy=%s`,
      async (proxied) => {
        deps.proxyPool = proxied ? new ProxyPool([`http://127.0.0.1:${proxy.port}`]) : undefined
        const app = new Elysia()
          .use(
            scrapeRoute(
              () => deps,
              () => true,
              metrics,
            ),
          )
          .use(v1Route({ orchestratorDeps: () => deps, poolReady: () => true, metricsStore: metrics }))
        const url = target("accept", proxied)
        const response = await app.handle(
          new Request(`http://localhost${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url,
              cmd: "request.get",
              solveEmbeddedCaptchas: true,
              maxTier: 3,
              maxTimeout: 10000,
            }),
          }),
        )
        const body = await response.json()
        expect(response.status, JSON.stringify(body)).toBe(200)
        expect(route === "/scrape" ? body.html : body.solution.response).toContain('id="status">accepted</p>')
        if (route === "/scrape") expect(body.captchasSolved).toEqual(["shumei"])
        expect(verified.get(new URL(url).searchParams.get("id") ?? "")).toBe(1)
        expect(browser.contexts()).toHaveLength(1)
      },
      20000,
    )
  }
})
