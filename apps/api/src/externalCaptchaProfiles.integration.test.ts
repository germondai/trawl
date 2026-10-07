import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { newFreshContext } from "@trawl/browser"
import { type CaptchaProfile, parseCaptchaProfiles } from "@trawl/tiers"
import { Elysia } from "elysia"
import { ExternalCaptchaSession } from "../../../packages/tiers/src/solvers/externalCaptcha"
import { routeChallengeWait } from "../../../packages/tiers/src/utils/challengeRouter"
import { getDeps, getPool, initPool, shutdownPools } from "./deps"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

const createApi = (deps: typeof getDeps) => new Elysia().use(scrapeRoute(deps)).use(v1Route({ orchestratorDeps: deps }))
describe.skipIf(process.env.TRAWL_EXTERNAL_CAPTCHA_TESTS !== "1")(
  "external CAPTCHA profile browser integration",
  () => {
    let fixture: ReturnType<typeof Bun.serve>
    let api: ReturnType<typeof createApi>
    const originalFetch = globalThis.fetch
    const tasks: Record<string, unknown>[] = []
    const profiles: CaptchaProfile[] = [
      {
        hostname: "127.0.0.1",
        selector: "#geetest-widget",
        taskType: "GeeTestTaskProxyless",
        inputs: {
          gt: { source: "global", path: ["sdkConfig", "gt"] },
          challenge: { source: "global", path: ["sdkConfig", "challenge"] },
        },
        delivery: {
          fields: [
            { selector: "#challenge", path: ["challenge"] },
            { selector: "#validate", path: ["validate"] },
            { selector: "#seccode", path: ["seccode"] },
          ],
          callback: "accept",
          verifySelector: "#accepted",
        },
      },
      {
        hostname: "127.0.0.1",
        selector: "#image-widget",
        taskType: "ImageToTextTask",
        inputs: { body: { source: "screenshot", selector: "#captcha-image" } },
        delivery: {
          fields: [{ selector: "#answer", path: ["text"] }],
          submitSelector: "#submit-answer",
          verifySelector: "#accepted",
        },
      },
      {
        hostname: "127.0.0.1",
        selector: "#grid-widget",
        taskType: "GridTask",
        inputs: {
          body: { source: "screenshot", selector: "#grid" },
          comment: { value: "Select cells one and four" },
          rows: { value: 2 },
          columns: { value: 2 },
        },
        delivery: {
          clicks: { selector: "#grid", path: ["click"], mode: "grid", rows: 2, columns: 2 },
          submitSelector: "#submit-grid",
          verifySelector: "#accepted",
        },
      },
      {
        hostname: "127.0.0.1",
        selector: "#coordinate-widget",
        taskType: "CoordinatesTask",
        inputs: { body: { source: "screenshot", selector: "#grid" }, comment: { value: "Click the first cell" } },
        delivery: {
          clicks: { selector: "#grid", path: ["coordinates"], mode: "coordinates", imageInput: "body" },
          submitSelector: "#submit-grid",
          verifySelector: "#accepted",
        },
      },
      {
        hostname: "127.0.0.1",
        selector: "#cookie-widget",
        taskType: "DataDomeSliderTask",
        inputs: { captchaUrl: { value: "https://geo.captcha-delivery.com/captcha/?t=fe&cid=owned-fixture" } },
        delivery: {
          cookies: [{ name: "datadome", path: ["cookie"], format: "set-cookie" }],
          reload: true,
          verifySelector: "#accepted",
        },
      },
    ]
    const options = { apiKey: "owned-profile-key", maxTasks: 1, localTimeoutMs: 1000, timeoutMs: 16000, profiles }
    const url = (path: string) => `http://127.0.0.1:${fixture.port}${path}`
    const solution = (type: unknown): unknown =>
      type === "GeeTestTaskProxyless"
        ? { challenge: "owned-solved", validate: "owned-validate", seccode: "owned-seccode" }
        : type === "ImageToTextTask"
          ? { text: "owned-answer" }
          : type === "GridTask"
            ? { click: [1, 4] }
            : type === "CoordinatesTask"
              ? { coordinates: [{ x: 25, y: 25 }] }
              : { cookie: "datadome=owned-cookie; Path=/; Secure; SameSite=Lax" }
    beforeAll(async () => {
      parseCaptchaProfiles(profiles)
      fixture = Bun.serve({
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname
          if (path === "/createTask") {
            const body = await request.json()
            expect(body.clientKey).toBe("owned-profile-key")
            tasks.push(body.task)
            return Response.json({ errorId: 0, taskId: tasks.length })
          }
          if (path === "/getTaskResult") {
            const body = await request.json()
            return Response.json({ errorId: 0, status: "ready", solution: solution(tasks[body.taskId - 1]?.type) })
          }
          if (path === "/verify") {
            const body = await request.json()
            return Response.json({
              accepted:
                (body.challenge === "owned-solved" &&
                  body.validate === "owned-validate" &&
                  body.seccode === "owned-seccode") ||
                body.answer === "owned-answer" ||
                body.clicks === "1,4" ||
                body.clicks === "1",
            })
          }
          if (path === "/cookie" && request.headers.get("cookie")?.includes("datadome=owned-cookie"))
            return new Response('<html><body><div id="accepted">Protected content</div></body></html>', {
              headers: { "content-type": "text/html" },
            })
          const name = path.includes("image")
            ? "image"
            : path.includes("coordinates")
              ? "coordinate"
              : path.includes("grid")
                ? "grid"
                : path.includes("cookie")
                  ? "cookie"
                  : "geetest"
          const widget = `<section id="${name}-widget"><input id="challenge"><input id="validate"><input id="seccode"><input id="answer"><div id="captcha-image" style="width:120px;height:50px;background:white;color:black">owned-answer</div><div id="grid" style="width:100px;height:100px;background:#aaa;display:grid;grid-template-columns:1fr 1fr"><span>1</span><span>2</span><span>3</span><span>4</span></div><button type="button" id="submit-answer">Verify text</button><button type="button" id="submit-grid">Verify grid</button></section>`
          const script = `window.sdkConfig={gt:'owned-gt',challenge:'owned-original'};window.accept=async()=>{const reply=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge:document.querySelector('#challenge').value,validate:document.querySelector('#validate').value,seccode:document.querySelector('#seccode').value})});if((await reply.json()).accepted)document.querySelector('#accepted').hidden=false};document.querySelector('#submit-answer').onclick=async()=>{const r=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answer:document.querySelector('#answer').value})});if((await r.json()).accepted)document.querySelector('#accepted').hidden=false};const clicks=[];document.querySelector('#grid').onclick=e=>{const b=e.currentTarget.getBoundingClientRect();clicks.push(1+Math.floor((e.clientX-b.x)/50)+2*Math.floor((e.clientY-b.y)/50))};document.querySelector('#submit-grid').onclick=async()=>{const r=await fetch('/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clicks:clicks.join(',')})});if((await r.json()).accepted)document.querySelector('#accepted').hidden=false};`
          return new Response(
            `<html><body>${name === "cookie" ? '<script>var dd={"rt":"c","host":"geo.captcha-delivery.com"}</script>' : ""}${widget}<div id="accepted" hidden>Protected content</div><p>${"Owned page content ".repeat(30)}</p><script>${script}</script></body></html>`,
            {
              headers: {
                "content-type": "text/html",
                ...(path === "/csp" ? { "content-security-policy": "script-src 'none'" } : {}),
              },
            },
          )
        },
      })
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
        return originalFetch(target.hostname === "api.2captcha.com" ? url(target.pathname) : input, init)
      }) as typeof fetch
      await initPool({ poolSize: 1, headfulPoolSize: 0 })
      api = createApi(() => ({ ...getDeps(), externalCaptcha: options })).listen(0)
    }, 120000)
    afterAll(async () => {
      globalThis.fetch = originalFetch
      await api?.stop()
      await shutdownPools()
      fixture?.stop(true)
    })
    test("native and Prowlarr routes escalate configured profiles and verify structured answers with the target", async () => {
      for (const route of ["/scrape", "/v1"]) {
        const response = await originalFetch(`http://127.0.0.1:${api.server?.port}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            route === "/scrape"
              ? { url: url("/geetest"), maxTimeout: 25000, maxTier: 3 }
              : { cmd: "request.get", url: url("/geetest"), maxTimeout: 25000 },
          ),
        })
        const result = await response.json()
        expect(response.status, JSON.stringify(result)).toBe(200)
        expect(result.html ?? result.solution?.response).toContain('<div id="accepted">')
        if (route === "/scrape") {
          expect(result.captchasSolved).toEqual(["geetest:2captcha"])
          expect(result.captchaDiagnostics).toContainEqual({ kind: "geetest", status: "verified" })
        }
        const deadline = Date.now() + 20000
        while (!getPool()?.getStats().available && Date.now() < deadline) await Bun.sleep(25)
        expect(getPool()?.getStats().available).toBe(1)
      }
    }, 60000)
    test("screenshots, grid clicks and coordinate scaling produce a verified target response", async () => {
      const pool = getPool()
      if (!pool) throw new Error("pool not ready")
      const lease = await pool.acquire()
      const context = await newFreshContext(lease.browser)
      try {
        const page = await context.newPage()
        for (const path of ["/image", "/grid", "/coordinates"]) {
          await page.goto(url(path))
          const session = new ExternalCaptchaSession(options)
          const solved = await session.solveProfiles(page, 16000)
          expect(solved, `${path}: ${JSON.stringify(session.diagnostics())}; task=${tasks.at(-1)?.type}`).toHaveLength(
            1,
          )
          expect(await page.evaluate(() => document.querySelector<HTMLElement>("#accepted")?.hidden)).toBe(false)
          expect(tasks.at(-1)?.body).toBeString()
        }
      } finally {
        await context.close()
        pool.release(lease.id, lease.lease)
      }
    }, 65000)
    test("a cookie answer is restricted to the current site and verified after reload", async () => {
      const pool = getPool()
      if (!pool) throw new Error("pool not ready")
      const lease = await pool.acquire()
      const proxy = `http://127.0.0.1:${fixture.port}`
      const context = await newFreshContext(lease.browser, { proxy })
      try {
        const page = await context.newPage()
        await page.goto(url("/cookie"))
        const result = await routeChallengeWait(
          page,
          await page.content(),
          {},
          16000,
          url("/cookie"),
          undefined,
          403,
          undefined,
          () => ({}),
          new ExternalCaptchaSession(options),
          proxy,
        )
        expect(result).toEqual({ challengeType: "none", resolution: "ok", captchasSolved: ["datadome:2captcha"] })
        expect(await page.content()).toContain('id="accepted"')
        expect(tasks.at(-1)?.proxyAddress).toBe("127.0.0.1")
        expect(await context.cookies()).toContainEqual(
          expect.objectContaining({ name: "datadome", value: "owned-cookie", domain: "127.0.0.1" }),
        )
      } finally {
        await context.close()
        pool.release(lease.id, lease.lease)
      }
    }, 30000)
    test("CSP, ambiguous targets and an already verified page spend no tasks", async () => {
      const pool = getPool()
      if (!pool) throw new Error("pool not ready")
      const lease = await pool.acquire()
      const context = await newFreshContext(lease.browser)
      try {
        const page = await context.newPage()
        const before = tasks.length
        await page.goto(url("/csp"))
        expect(await new ExternalCaptchaSession(options).solveProfiles(page, 16000)).toEqual([])
        await page.goto(url("/geetest"))
        await page.evaluate(() => {
          const accepted = document.querySelector<HTMLElement>("#accepted")
          if (!accepted) throw new Error("Missing fixture success target")
          accepted.hidden = false
        })
        expect(await new ExternalCaptchaSession(options).solveProfiles(page, 16000)).toEqual([])
        await page.evaluate(() => {
          const accepted = document.querySelector<HTMLElement>("#accepted")
          const widget = document.querySelector("#geetest-widget")
          if (!accepted || !widget) throw new Error("Missing fixture target")
          accepted.hidden = true
          document.body.appendChild(widget.cloneNode(true))
        })
        expect(await new ExternalCaptchaSession(options).solveProfiles(page, 16000)).toEqual([])
        expect(tasks.length).toBe(before)
      } finally {
        await context.close()
        pool.release(lease.id, lease.lease)
      }
    }, 30000)
  },
)
