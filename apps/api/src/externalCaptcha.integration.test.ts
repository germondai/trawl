import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { newFreshContext } from "@trawl/browser"
import { Elysia } from "elysia"
import { ExternalCaptchaSession } from "../../../packages/tiers/src/solvers/externalCaptcha"
import { getDeps, getPool, initPool, shutdownPools } from "./deps"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

const createTestApi = (deps: typeof getDeps) =>
  new Elysia().use(scrapeRoute(deps)).use(v1Route({ orchestratorDeps: deps }))

describe.skipIf(process.env.TRAWL_EXTERNAL_CAPTCHA_TESTS !== "1")("external CAPTCHA browser integration", () => {
  let fixture: ReturnType<typeof Bun.serve>
  let api: ReturnType<typeof createTestApi>
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const tasks: Record<string, unknown>[] = []
  const url = (path: string) => `http://127.0.0.1:${fixture.port}${path}`
  const options = { apiKey: "owned-fixture-key", maxTasks: 1, timeoutMs: 12000, localTimeoutMs: 1000 }

  beforeAll(async () => {
    fixture = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/createTask" || path === "/getTaskResult") {
          calls.push(path)
          const body = await request.json()
          expect(body.clientKey).toBe("owned-fixture-key")
          if (path === "/createTask") tasks.push(body.task)
          return Response.json(
            path === "/createTask"
              ? { errorId: 0, taskId: 42 }
              : {
                  errorId: 0,
                  status: "ready",
                  solution: { token: "owned-provider-response", gRecaptchaResponse: "owned-provider-response" },
                },
          )
        }
        const recaptcha = path === "/recaptcha" || path === "/recaptcha-net" || path === "/enterprise"
        const multiple = path === "/multiple"
        const fieldName =
          path === "/custom-field"
            ? "owned-turnstile-token"
            : recaptcha || path === "/compat"
              ? "g-recaptcha-response"
              : "cf-turnstile-response"
        const attrs =
          path === "/custom-field"
            ? 'data-response-field-name="owned-turnstile-token"'
            : path === "/no-field"
              ? 'data-response-field="false"'
              : ""
        const widget = `<div ${path === "/enterprise" ? 'data-s="owned-s"' : ""} ${attrs} class="${recaptcha ? "g-recaptcha" : "cf-turnstile"}" data-sitekey="owned-sitekey" data-callback="fixture.accept"></div>`
        return new Response(
          `<html><head><title>Owned contact form</title>${path === "/enterprise" ? '<script src="https://www.google.com/recaptcha/enterprise.js"></script>' : path === "/recaptcha-net" ? '<script src="https://www.recaptcha.net/recaptcha/api.js"></script>' : path === "/compat" ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?compat=recaptcha"></script>' : ""}</head><body><form>${widget}${multiple ? widget : ""}${path === "/no-field" ? "" : `<textarea name="${fieldName}" hidden></textarea>`}<button type="submit">Submit</button></form><p>${"Fixture page content ".repeat(20)}</p><script>window.fixture={accept(token){if(token==='owned-provider-response')document.body.dataset.accepted='true'}};document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.submitted='true'}</script></body></html>`,
          {
            headers: {
              "content-type": "text/html",
              ...(path === "/csp" ? { "content-security-policy": "script-src 'none'" } : {}),
            },
          },
        )
      },
    })
    // Only the provider transport is redirected to the owned HTTP fixture.
    // No real paid endpoint is reached, including on failure.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (target.hostname === "api.2captcha.com") return originalFetch(url(target.pathname), init)
      return originalFetch(input, init)
    }) as typeof fetch
    await initPool({ poolSize: 1, headfulPoolSize: 0 })
    const deps = () => ({ ...getDeps(), externalCaptcha: options })
    api = new Elysia()
      .use(scrapeRoute(deps))
      .use(v1Route({ orchestratorDeps: deps }))
      .listen(0)
  }, 120000)

  afterAll(async () => {
    globalThis.fetch = originalFetch
    await api?.stop()
    await shutdownPools()
    fixture?.stop(true)
  })

  test("native and Prowlarr routes run local solving before external fallback", async () => {
    for (const route of ["/scrape", "/v1"]) {
      const before = calls.length
      const response = await originalFetch(`http://127.0.0.1:${api.server?.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          route === "/scrape"
            ? { url: url("/turnstile"), skipHttp: true, maxTier: 3, maxTimeout: 20000 }
            : { cmd: "request.get", url: url("/turnstile"), maxTimeout: 20000 },
        ),
      })
      const result = await response.json()
      expect(response.status, JSON.stringify(result)).toBe(200)
      const html = result.html ?? result.solution?.response
      expect(html).toContain('data-accepted="true"')
      expect(html).not.toContain('data-submitted="true"')
      if (route === "/scrape") expect(result.captchasSolved).toEqual(["turnstile:2captcha"])
      expect(calls.slice(before)).toEqual(["/createTask", "/getTaskResult"])
      const deadline = Date.now() + 20000
      while (!getPool()?.getStats().available && Date.now() < deadline) await Bun.sleep(20)
      expect(getPool()?.getStats().available).toBe(1)
    }
  }, 50000)

  test("declarative reCAPTCHA without an anchor iframe falls back through the native API", async () => {
    const response = await originalFetch(`http://127.0.0.1:${api.server?.port}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url("/recaptcha"), skipHttp: true, maxTier: 3, maxTimeout: 20000 }),
    })
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.captchasSolved).toEqual(["recaptcha-v2:2captcha"])
    expect(result.html).toContain('data-accepted="true"')
  }, 30000)

  test("Turnstile custom response names and callback-only widgets receive the token", async () => {
    const pool = getPool()
    if (!pool) throw new Error("pool not ready")
    const lease = await pool.acquire()
    const context = await newFreshContext(lease.browser)
    try {
      const page = await context.newPage()
      await page.route("https://challenges.cloudflare.com/**", (route: { abort(): Promise<void> }) => route.abort())
      for (const path of ["/custom-field", "/no-field", "/compat"]) {
        await page.goto(url(path))
        expect(await new ExternalCaptchaSession(options).solve(page, "turnstile", 12000)).toBe(true)
        expect(await page.evaluate(() => document.body.dataset.accepted)).toBe("true")
        expect(
          await page.evaluate(
            () => document.querySelector<HTMLTextAreaElement>('[name="owned-turnstile-token"]')?.value ?? null,
          ),
        ).toBe(path === "/custom-field" ? "owned-provider-response" : null)
        expect(await page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]'))).toBeNull()
        if (path === "/compat")
          expect(
            await page.evaluate(
              () => document.querySelector<HTMLTextAreaElement>('[name="g-recaptcha-response"]')?.value,
            ),
          ).toBe("owned-provider-response")
      }
    } finally {
      await context.close()
      pool.release(lease.id, lease.lease)
    }
  }, 35000)

  test("reCAPTCHA callback runs in the page realm; ambiguous widgets spend nothing and CSP fails safely", async () => {
    const pool = getPool()
    if (!pool) throw new Error("pool not ready")
    const lease = await pool.acquire()
    const context = await newFreshContext(lease.browser)
    try {
      const page = await context.newPage()
      await page.route("https://www.recaptcha.net/**", (route: { abort(): Promise<void> }) => route.abort())
      await page.goto(url("/recaptcha-net"))
      expect(await new ExternalCaptchaSession(options).solve(page, "recaptcha-v2", 12000)).toBe(true)
      expect(tasks.at(-1)).toMatchObject({
        apiDomain: "recaptcha.net",
        userAgent: await page.evaluate(() => navigator.userAgent),
      })
      expect(await page.evaluate(() => document.body.dataset.accepted)).toBe("true")
      await page.route("https://www.google.com/**", (route: { abort(): Promise<void> }) => route.abort())
      await page.goto(url("/enterprise"))
      expect(await new ExternalCaptchaSession(options).solve(page, "recaptcha-v2-enterprise", 12000)).toBe(true)
      expect(tasks.at(-1)).toMatchObject({
        type: "RecaptchaV2EnterpriseTaskProxyless",
        enterprisePayload: { s: "owned-s" },
      })
      expect(await page.evaluate(() => document.body.dataset.accepted)).toBe("true")
      const before = calls.length
      await page.goto(url("/multiple"))
      expect(await new ExternalCaptchaSession(options).solve(page, "turnstile", 12000)).toBe(false)
      expect(calls.length).toBe(before)
      await page.goto(url("/csp"))
      expect(await new ExternalCaptchaSession(options).solve(page, "turnstile", 12000)).toBe(false)
      expect(await page.evaluate(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value)).toBe("")
    } finally {
      await context.close()
      pool.release(lease.id, lease.lease)
    }
  }, 35000)
})
