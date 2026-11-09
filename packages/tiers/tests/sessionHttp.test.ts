import { afterEach, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { Cookie, ScrapeRequest, SessionData } from "@trawl/types"
import { type OrchestratorDeps, scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { HttpSessionCookies, httpReplayProof } from "../src/utils/httpSessionCookies"
import { ProxyPool } from "../src/utils/proxyRotator"

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

function clearance(domain = "example.test", extra: Partial<Cookie> = {}): Cookie {
  return {
    name: "cf_clearance",
    value: "verified",
    domain,
    path: "/",
    expires: Date.now() / 1000 + 3600,
    secure: true,
    httpOnly: true,
    ...extra,
  }
}

function cached(cookies = [clearance()]): SessionData {
  return { cookies, userAgent: "cached-agent", savedAt: Date.now(), httpOrigin: "https://example.test" }
}

describe("HTTP clearance boundaries", () => {
  test.each([
    "techaro.lol-anubis-auth",
    "techaro.lol-anubis",
    "techaro.lol-anubis-a1b2c3d4",
    "techaro.lol-anubis-auth-a1b2c3d4",
  ])("accepts browser-verified Anubis auth cookie %s with the same origin restrictions", (name) => {
    const session = cached([clearance("example.test", { name })])
    expect(HttpSessionCookies.from(session, "https://example.test/")?.header("https://example.test/")).toBe(
      `${name}=verified`,
    )
    expect(HttpSessionCookies.from(session, "https://other.test/")).toBeUndefined()
    expect(HttpSessionCookies.from({ ...session, httpOrigin: undefined }, "https://example.test/")).toBeUndefined()
    expect(
      HttpSessionCookies.from(cached([clearance("example.test", { name, expires: 1 })]), "https://example.test/"),
    ).toBeUndefined()
  })

  test("does not replay an unverified generic session", () => {
    const session = cached([clearance("example.test", { name: "session", value: "logged-in" })])
    expect(HttpSessionCookies.from(session, "https://example.test/")).toBeUndefined()
  })

  test("generic replay binds document structure and attributes to the verified URL", () => {
    const html = '<html><body><a href="/correct">Details</a></body></html>'
    const session = cached([clearance("example.test", { name: "session" })])
    session.httpReplay = httpReplayProof("https://example.test/", html, session.cookies)
    const jar = HttpSessionCookies.from(session, "https://example.test/")
    expect(jar?.matchesDocument("https://example.test/", html)).toBe(true)
    expect(jar?.matchesDocument("https://example.test/", html.replace("/correct", "/wrong"))).toBe(false)
    expect(
      jar?.matchesDocument(
        "https://example.test/",
        html.replace("<body>", "<head><title>Different page</title></head><body>"),
      ),
    ).toBe(false)
    expect(HttpSessionCookies.from(session, "https://example.test/other")).toBeUndefined()
    expect(
      httpReplayProof("https://example.test/", `<html><body>${"a".repeat(262_144)}</body></html>`, session.cookies),
    ).toBeUndefined()
  })

  test("honors host-only/domain cookies, paths, expiry, secure transport and longest path first", () => {
    const jar = HttpSessionCookies.from(
      cached([
        clearance(),
        clearance(".example.test", { name: "parent" }),
        clearance("child.example.test", { name: "child" }),
        clearance("other.test", { name: "unrelated" }),
        clearance("example.test", { name: "expired", expires: 1 }),
        clearance("example.test", { name: "scoped", path: "/a" }),
      ]),
      "https://example.test/a/b",
    )
    expect(jar?.header("https://example.test/a/b")).toBe("scoped=verified; cf_clearance=verified; parent=verified")
    expect(jar?.header("https://example.test/ab")).toBe("cf_clearance=verified; parent=verified")
    expect(() => jar?.header("https://child.example.test/")).toThrow("session-redirect-needs-browser")
    expect(() => jar?.header("http://example.test/")).toThrow("session-redirect-needs-browser")
    expect(
      HttpSessionCookies.from(cached([clearance("example.test", { expires: 1 })]), "https://example.test/"),
    ).toBeUndefined()
    expect(HttpSessionCookies.from({ ...cached(), httpOrigin: undefined }, "https://example.test/")).toBeUndefined()
    expect(HttpSessionCookies.from(cached(), "https://example.test:8443/")).toBeUndefined()
  })

  test("rotates and deletes cookies without changing the saved session or accepting foreign domains", () => {
    const session = cached([clearance(), clearance("example.test", { name: "remove" })])
    const jar = HttpSessionCookies.from(session, "https://example.test/")
    if (!jar) throw new Error("Expected a usable clearance")
    const headers = new Headers()
    headers.append("set-cookie", "cf_clearance=rotated; Path=/; Secure; HttpOnly; Max-Age=60")
    headers.append("set-cookie", "remove=; Path=/; Max-Age=0; Expires=Wed, 21 Oct 2037 07:28:00 GMT")
    headers.append("set-cookie", "scoped=path; HttpOnly")
    headers.append("set-cookie", "foreign=secret; Domain=other.test; Path=/")
    jar.update(headers, "https://example.test/a/b")
    expect(jar.header("https://example.test/a/c")).toBe("scoped=path; cf_clearance=rotated")
    expect(jar.header("https://example.test/")).toBe("cf_clearance=rotated")
    expect(jar.snapshot().find((cookie) => cookie.name === "cf_clearance")).toMatchObject({
      secure: true,
      httpOnly: true,
    })
    expect(session.cookies).toHaveLength(2)
    expect(session.cookies[0]?.value).toBe("verified")
  })

  test("returns partitioned or unverified parent-domain cookie policies to the browser", () => {
    const jar = HttpSessionCookies.from(cached(), "https://example.test/")
    if (!jar) throw new Error("Expected a usable clearance")
    expect(() =>
      jar.update(new Headers({ "set-cookie": "a=b; Partitioned; Secure" }), "https://example.test/"),
    ).toThrow("session-cookies-need-browser")
    expect(() =>
      jar.update(new Headers({ "set-cookie": "a=b; Domain=test; Path=/" }), "https://example.test/"),
    ).toThrow("session-cookies-need-browser")
  })

  test("recomputes cookies on each redirect, applies rotation, and refuses a different origin before contacting it", async () => {
    const seen: (string | null)[] = []
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("cookie"))
        switch (new URL(request.url).pathname) {
          case "/a/start":
            return new Response(null, {
              status: 302,
              headers: { location: "/done", "set-cookie": "cf_clearance=new; Path=/" },
            })
          case "/away":
            return Response.redirect(`http://localhost:${new URL(request.url).port}/leaked`)
          default:
            return new Response("<html><body>Actual content</body></html>", {
              headers: { "content-type": "text/html" },
            })
        }
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    const session = {
      ...cached([
        clearance("127.0.0.1", { secure: false }),
        clearance("127.0.0.1", { name: "scoped", path: "/a", secure: false }),
      ]),
      httpOrigin: origin,
    }
    const jar = HttpSessionCookies.from(session, `${origin}/a/start`)
    if (!jar) throw new Error("Expected a usable clearance")
    const result = await runTier1(
      `${origin}/a/start`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jar,
    )
    expect(result).toMatchObject({ status: "success", effectiveUrl: `${origin}/done` })
    expect(seen).toEqual(["scoped=verified; cf_clearance=verified", "cf_clearance=new"])
    const refused = await runTier1(
      `${origin}/away`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jar,
    )
    expect(refused).toMatchObject({ status: "error", reason: "session-redirect-needs-browser" })
    expect(seen).toHaveLength(3)
  })
})

test.each([false, true])("generic session replay verifies rendered content (partial=%s)", async (partial) => {
  const complete = "<html><body><nav>Site navigation</nav><main>Verified application content</main></body></html>"
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (!request.headers.get("cookie")?.includes("session=verified"))
        return new Response("Access denied", { status: 403, headers: { "content-type": "text/html" } })
      return new Response(
        partial
          ? '<html><body><nav>Site navigation</nav><main id="root"></main><script src="/app.js"></script></body></html>'
          : complete,
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  const url = `http://127.0.0.1:${server.port}/`
  let saved: SessionData | undefined
  let checkouts = 0
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => {
      checkouts++
      return { fingerprint: { userAgent: "verified-agent" } } as BrowserHandle
    },
    releaseBrowser: () => {},
    loadSession: async () => saved,
    saveSession: async (_domain, data) => {
      saved = data
    },
    invalidateSession: async () => {
      saved = undefined
    },
  }
  const browserResult = {
    status: "success" as const,
    durationMs: 1,
    html: complete,
    effectiveUrl: url,
    contentType: "text/html",
    userAgent: "verified-agent",
    cookies: [clearance("127.0.0.1", { name: "session", secure: false })],
  }
  await scrape({ url }, deps, { tier3: async () => ({ ...browserResult, tier: 3 }) })
  const result = await scrape({ url }, deps, { tier2: async () => ({ ...browserResult, tier: 2 }) })
  expect(result.html).toContain("Verified application content")
  expect(result.tier).toBe(partial ? 2 : 1)
  expect(checkouts).toBe(partial ? 2 : 1)
})

describe("HTTP clearance fallback", () => {
  const html = "<html><body>Actual content</body></html>"
  const success = { status: "success" as const, durationMs: 1, html, effectiveUrl: "https://example.test/" }

  test.each([
    [
      "rejected Anubis clearance",
      '<html><script id="anubis_challenge" type="application/json">{}</script><title>Making sure you are not a bot!</title></html>',
    ],
    ["rejected clearance", "<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>"],
    ["embedded Turnstile", '<html><body><div class="cf-turnstile" data-sitekey="site"></div></body></html>'],
    [
      "JavaScript application shell",
      '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
    ],
  ])("keeps browser solving for %s", async (_name, wall) => {
    server = Bun.serve({ port: 0, fetch: () => new Response(wall, { headers: { "content-type": "text/html" } }) })
    const origin = `http://127.0.0.1:${server.port}`
    let checkouts = 0
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => {
        checkouts++
        return {} as BrowserHandle
      },
      releaseBrowser: () => {},
      loadSession: async () => ({ ...cached([clearance("127.0.0.1", { secure: false })]), httpOrigin: origin }),
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const result = await scrape({ url: origin, maxTier: 2 }, deps, { tier2: async () => ({ ...success, tier: 2 }) })
    expect(result.tier).toBe(2)
    expect(result.timings.map((timing) => timing.status)).toEqual(["needs-js", "success"])
    expect(checkouts).toBe(1)
  })

  test.each([
    { name: "POST", request: { method: "POST", headers: { "Content-Type": "text/plain" }, body: "body" } },
    {
      name: "httpReplay on PUT",
      request: { method: "PUT", httpReplay: true, headers: { "Content-Type": "text/plain" }, body: "body" },
    },
    { name: "skipHttp", request: { skipHttp: true } },
    { name: "explicit proxy", request: { proxy: "http://proxy.test:8080" } },
    { name: "screenshot", request: { screenshot: true } },
    { name: "content selector", request: { contentWaitForSelector: "#loaded" } },
    { name: "response capture", request: { captureResponses: ["/api/"] } },
    { name: "network logs", request: { networkLogs: true } },
    { name: "MHTML", request: { mhtml: true } },
    { name: "TLS opt-out", request: { ignoreCertificateErrors: true } },
    { name: "imported cookies", request: { cookies: [{ name: "login", value: "private" }] } },
  ] satisfies { name: string; request: Partial<ScrapeRequest> }[])(
    "preserves the browser path for $name",
    async ({ request: options }) => {
      let replay = false
      const deps: OrchestratorDeps = {
        acquireBrowser: async () => ({ fingerprint: { userAgent: "browser-agent" } }) as BrowserHandle,
        releaseBrowser: () => {},
        loadSession: async () => cached(),
        saveSession: async () => {},
        invalidateSession: async () => {},
      }
      await scrape({ url: "https://example.test/", maxTier: 3, ...options }, deps, {
        tier1: async (...args) => {
          replay = Boolean(args[9])
          return { tier: 1, status: "needs-js", durationMs: 1 }
        },
        tier2: async () => ({ ...success, tier: 2 }),
        tier3: async () => ({ ...success, tier: 3 }),
      })
      expect(replay).toBe(false)
    },
  )

  test("does not replay clearance through a different configured egress", async () => {
    let replay = false
    await scrape(
      { url: "https://example.test/", maxTier: 1 },
      {
        acquireBrowser: async () => {
          throw new Error("Unexpected browser checkout")
        },
        releaseBrowser: () => {},
        loadSession: async () => cached(),
        saveSession: async () => {},
        invalidateSession: async () => {},
        proxyPool: new ProxyPool(["http://proxy.test:8080"]),
      },
      {
        tier1: async (...args) => {
          replay = Boolean(args[9])
          return { ...success, tier: 1 }
        },
      },
    )
    expect(replay).toBe(false)
  })

  test("bounds an unresponsive HTTP replay and leaves time for browser fallback", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const origin = `http://127.0.0.1:${server.port}`
    let remaining = 0
    let httpDeadline = 0
    const result = await scrape(
      { url: origin, maxTier: 2, maxTimeout: 900 },
      {
        acquireBrowser: async (_domain, budgetMs) => {
          remaining = budgetMs ?? 0
          return {} as BrowserHandle
        },
        releaseBrowser: () => {},
        loadSession: async () => ({ ...cached([clearance("127.0.0.1", { secure: false })]), httpOrigin: origin }),
        saveSession: async () => {},
        invalidateSession: async () => {},
      },
      {
        tier1: async (...args) => {
          httpDeadline = args[10] ?? 0
          return runTier1(...args)
        },
        tier2: async () => ({ ...success, tier: 2 }),
      },
    )
    expect(result.tier).toBe(2)
    expect(result.timings[0]?.status).toBe("error")
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(800)
    expect(httpDeadline).toBeGreaterThan(0)
    expect(httpDeadline).toBeLessThanOrEqual(300)
  })
})

test.each(["cf_clearance", "techaro.lol-anubis-auth"])(
  "reuses verified %s over HTTP without checking out a browser",
  async (name) => {
    const seen: { cookie: string | null; agent: string | null }[] = []
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push({ cookie: request.headers.get("cookie"), agent: request.headers.get("user-agent") })
        if (!request.headers.get("cookie")?.includes(`${name}=verified`)) {
          return new Response("<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>", {
            status: 403,
            headers: { "content-type": "text/html" },
          })
        }
        return new Response(
          '<html><head><script src="/enhance.js"></script></head><body>Actual destination</body></html>',
          {
            headers: { "content-type": "text/html", "set-cookie": "fresh=value; Path=/; HttpOnly" },
          },
        )
      },
    })
    const url = `http://127.0.0.1:${server.port}/`
    let saved: SessionData | undefined
    let checkouts = 0
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => {
        checkouts++
        return { fingerprint: { userAgent: "browser-agent" } } as BrowserHandle
      },
      releaseBrowser: () => {},
      loadSession: async () => saved,
      saveSession: async (_domain, data) => {
        saved = data
      },
      invalidateSession: async () => {
        saved = undefined
      },
    }
    await scrape({ url, maxTier: 3 }, deps, {
      tier3: async () => ({
        tier: 3,
        status: "success",
        durationMs: 1,
        html: "<html><body>Actual destination</body></html>",
        effectiveUrl: url,
        userAgent: "browser-agent",
        cookies: [
          {
            name,
            value: "verified",
            domain: "127.0.0.1",
            path: "/",
            expires: Date.now() / 1000 + 3600,
            secure: false,
            httpOnly: true,
          },
        ],
      }),
    })
    const result = await scrape({ url, maxTier: 1 }, deps)
    expect(result).toMatchObject({ tier: 1, sessionCached: true, userAgent: "browser-agent" })
    expect(result.html).toContain("Actual destination")
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([name, "fresh"])
    expect(saved?.cookies).toEqual(result.cookies)
    expect(checkouts).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual({ cookie: `${name}=verified`, agent: "browser-agent" })
  },
)

describe("HTTP clearance replay for opted-in POST requests", () => {
  const form = { method: "POST" as const, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  const challengePage = () =>
    new Response("<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })
  const localDeps = (origin: string, onCheckout?: () => void): OrchestratorDeps => ({
    acquireBrowser: async () => {
      if (!onCheckout) throw new Error("Unexpected browser checkout")
      onCheckout()
      return {} as BrowserHandle
    },
    releaseBrowser: () => {},
    loadSession: async () => ({ ...cached([clearance("127.0.0.1", { secure: false })]), httpOrigin: origin }),
    saveSession: async () => {},
    invalidateSession: async () => {},
  })
  const submission = (origin: string, extra: Partial<ScrapeRequest> = {}): ScrapeRequest => ({
    url: `${origin}/submit`,
    ...form,
    body: "field=value",
    httpReplay: true,
    ...extra,
  })

  test("hands the shared jar to Tier 1 only when the POST opts in", async () => {
    const replays: boolean[] = []
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => ({ fingerprint: { userAgent: "browser-agent" } }) as BrowserHandle,
      releaseBrowser: () => {},
      loadSession: async () => cached(),
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const runners = {
      tier1: async (...args: Parameters<typeof runTier1>) => {
        replays.push(Boolean(args[9]))
        return {
          tier: 1 as const,
          status: "needs-js" as const,
          durationMs: 1,
          reason: "cloudflare-challenge",
          challenge: "cloudflare-interstitial" as const,
          explicitChallenge: true,
        }
      },
      tier2: async () => ({
        tier: 2 as const,
        status: "success" as const,
        durationMs: 1,
        html: "<html><body>Rendered</body></html>",
        effectiveUrl: "https://example.test/",
      }),
    }
    await scrape({ url: "https://example.test/", ...form, body: "a=1" }, deps, runners)
    await scrape({ url: "https://example.test/", ...form, body: "a=1", httpReplay: true }, deps, runners)
    await scrape({ url: "https://example.test/", ...form, body: "a=1", httpReplay: false }, deps, runners)
    expect(replays).toEqual([false, true, false])
  })

  test("ignores the generic document proof for an opted-in POST", async () => {
    const html = "<html><body><main>Verified application content</main></body></html>"
    const session = cached([clearance("example.test", { name: "session" })])
    session.httpReplay = httpReplayProof("https://example.test/", html, session.cookies)
    const replays: boolean[] = []
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => ({ fingerprint: { userAgent: "browser-agent" } }) as BrowserHandle,
      releaseBrowser: () => {},
      loadSession: async () => session,
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const runners = {
      tier1: async (...args: Parameters<typeof runTier1>) => {
        replays.push(Boolean(args[9]))
        return { tier: 1 as const, status: "needs-js" as const, durationMs: 1 }
      },
      tier3: async () => ({
        tier: 3 as const,
        status: "success" as const,
        durationMs: 1,
        html,
        effectiveUrl: "https://example.test/",
      }),
    }
    await scrape({ url: "https://example.test/" }, deps, runners)
    await scrape({ url: "https://example.test/", ...form, body: "field=value", httpReplay: true }, deps, runners)
    expect(replays).toEqual([true, false])
  })

  test("gives an opted-in POST replay the request's own deadline", async () => {
    const budgets: number[] = []
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => ({ fingerprint: { userAgent: "browser-agent" } }) as BrowserHandle,
      releaseBrowser: () => {},
      loadSession: async () => cached(),
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const runners = {
      tier1: async (...args: Parameters<typeof runTier1>) => {
        budgets.push(args[10] ?? 0)
        return {
          tier: 1 as const,
          status: "success" as const,
          durationMs: 1,
          html: "<html><body>Accepted</body></html>",
          effectiveUrl: args[0],
        }
      },
    }
    await scrape({ url: "https://example.test/", maxTimeout: 30_000 }, deps, runners)
    await scrape(
      { url: "https://example.test/", ...form, body: "field=value", httpReplay: true, maxTimeout: 30_000 },
      deps,
      runners,
    )
    expect(budgets[0]).toBeLessThanOrEqual(5000)
    expect(budgets[1]).toBeGreaterThan(5000)
    expect(budgets[1]).toBeLessThanOrEqual(30_000)
  })

  test("forwards an opted-in POST with its body and writes the reply's cookies back", async () => {
    const seen: { method: string; cookie: string | null; type: string | null; body: string }[] = []
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const cookie = request.headers.get("cookie")
        seen.push({
          method: request.method,
          cookie,
          type: request.headers.get("content-type"),
          body: await request.text(),
        })
        if (!cookie?.includes("cf_clearance=verified")) return challengePage()
        if (new URL(request.url).pathname === "/page") {
          return new Response("<html><body>Page</body></html>", {
            headers: { "content-type": "text/html", "set-cookie": "sid=first; Path=/; HttpOnly" },
          })
        }
        if (request.method !== "POST" || !cookie.includes("sid=first")) {
          return new Response('{"result":"rejected"}', { headers: { "content-type": "application/json" } })
        }
        const headers = new Headers({ "content-type": "application/json" })
        headers.append("set-cookie", "sid=second; Path=/; HttpOnly")
        headers.append("set-cookie", "cf_clearance=rotated; Path=/; HttpOnly")
        return new Response('{"result":"ok"}', { headers })
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    let saved: SessionData | undefined = { ...cached([clearance("127.0.0.1", { secure: false })]), httpOrigin: origin }
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => {
        throw new Error("Unexpected browser checkout")
      },
      releaseBrowser: () => {},
      loadSession: async () => saved,
      saveSession: async (_domain, data) => {
        saved = data
      },
      invalidateSession: async () => {
        saved = undefined
      },
    }
    const page = await scrape({ url: `${origin}/page`, maxTier: 1 }, deps)
    expect(page).toMatchObject({ tier: 1, sessionCached: true })
    const result = await scrape(
      { url: `${origin}/submit`, ...form, body: "field=value", httpReplay: true, maxTier: 1 },
      deps,
    )
    expect(result).toMatchObject({ tier: 1, sessionCached: true, statusCode: 200 })
    expect(JSON.parse(result.html)).toEqual({ result: "ok" })
    expect(seen).toEqual([
      { method: "GET", cookie: "cf_clearance=verified", type: null, body: "" },
      {
        method: "POST",
        cookie: "cf_clearance=verified; sid=first",
        type: "application/x-www-form-urlencoded",
        body: "field=value",
      },
    ])
    expect(Object.fromEntries(saved?.cookies.map((cookie) => [cookie.name, cookie.value]) ?? [])).toEqual({
      cf_clearance: "rotated",
      sid: "second",
    })
  })

  test.each([
    ["its header", () => new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } })],
    ["a 403 interstitial", challengePage],
  ])(
    "continues to the browser after a challenge announced by %s, within the original deadline",
    async (_name, respond) => {
      let submissions = 0
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method === "POST") submissions++
          await Bun.sleep(300)
          return respond()
        },
      })
      const origin = `http://127.0.0.1:${server.port}`
      let browserBudget = 0
      let tier2Budget = 0
      const result = await scrape(
        submission(origin, { maxTier: 2, maxTimeout: 2000 }),
        {
          ...localDeps(origin),
          acquireBrowser: async (_domain, budgetMs) => {
            browserBudget = budgetMs ?? 0
            return {} as BrowserHandle
          },
        },
        {
          tier2: async (_url: string, _handle: BrowserHandle, _session: SessionData, maxTimeout: number) => {
            tier2Budget = maxTimeout
            return {
              tier: 2 as const,
              status: "success" as const,
              durationMs: 1,
              html: '{"result":"ok"}',
              effectiveUrl: `${origin}/submit`,
            }
          },
        },
      )
      expect(result.tier).toBe(2)
      expect(result.timings.map((timing) => [timing.status, timing.reason])).toEqual([
        ["needs-js", "cloudflare-challenge"],
        ["success", undefined],
      ])
      expect(submissions).toBe(1)
      expect(browserBudget).toBeGreaterThan(0)
      expect(browserBudget).toBeLessThan(1750)
      expect(tier2Budget).toBeGreaterThan(0)
      expect(tier2Budget).toBeLessThan(1750)
    },
  )

  test("refuses a cross-origin redirect of an opted-in POST without resending", async () => {
    let elsewhere = 0
    const other = Bun.serve({
      port: 0,
      fetch: () => {
        elsewhere++
        return new Response("leaked")
      },
    })
    try {
      let submissions = 0
      server = Bun.serve({
        port: 0,
        fetch(request) {
          if (request.method === "POST") submissions++
          return new Response(null, { status: 307, headers: { location: `http://localhost:${other.port}/elsewhere` } })
        },
      })
      const origin = `http://127.0.0.1:${server.port}`
      let checkouts = 0
      await expect(
        scrape(
          submission(origin),
          localDeps(origin, () => {
            checkouts++
          }),
        ),
      ).rejects.toThrow("session-redirect-needs-browser")
      expect(submissions).toBe(1)
      expect(elsewhere).toBe(0)
      expect(checkouts).toBe(0)
    } finally {
      other.stop(true)
    }
  })

  test("does not resend an opted-in POST whose response stalls", async () => {
    let submissions = 0
    let checkouts = 0
    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "POST") submissions++
        return new Promise<Response>(() => {})
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    await expect(
      scrape(
        submission(origin, { maxTimeout: 700 }),
        localDeps(origin, () => {
          checkouts++
        }),
      ),
    ).rejects.toThrow()
    await Bun.sleep(200)
    expect(submissions).toBe(1)
    expect(checkouts).toBe(0)
  })

  test("does not resend an opted-in POST whose connection drops", async () => {
    let submissions = 0
    let checkouts = 0
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          if (data.toString().includes("POST /submit")) submissions++
          socket.end()
        },
      },
    })
    try {
      const origin = `http://127.0.0.1:${listener.port ?? 0}`
      await expect(
        scrape(
          submission(origin, { maxTimeout: 700 }),
          localDeps(origin, () => {
            checkouts++
          }),
        ),
      ).rejects.toThrow("not resent")
      await Bun.sleep(200)
      expect(submissions).toBe(1)
      expect(checkouts).toBe(0)
    } finally {
      listener.stop(true)
    }
  })

  test("does not resend an opted-in POST when the server closes a reused connection", async () => {
    let submissions = 0
    let checkouts = 0
    const page = "<html><body>Page</body></html>"
    const listener = Bun.listen<{ buffer: string }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { buffer: "" }
        },
        data(socket, chunk) {
          socket.data.buffer += chunk.toString()
          for (;;) {
            const end = socket.data.buffer.indexOf("\r\n\r\n")
            if (end === -1) return
            const head = socket.data.buffer.slice(0, end)
            const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0)
            if (socket.data.buffer.length < end + 4 + length) return
            socket.data.buffer = socket.data.buffer.slice(end + 4 + length)
            if (head.startsWith("POST ")) {
              submissions++
              if (submissions === 1) {
                socket.end()
                return
              }
            }
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${page.length}\r\n\r\n${page}`)
          }
        },
      },
    })
    try {
      const origin = `http://127.0.0.1:${listener.port ?? 0}`
      const deps = localDeps(origin, () => {
        checkouts++
      })
      const first = await scrape({ url: `${origin}/page`, maxTier: 1, maxTimeout: 1000 }, deps)
      expect(first).toMatchObject({ tier: 1, sessionCached: true })
      await expect(scrape(submission(origin, { maxTimeout: 700 }), deps)).rejects.toThrow(
        /not resent|deadline exceeded/i,
      )
      await Bun.sleep(200)
      expect(submissions).toBe(1)
      expect(checkouts).toBe(0)
    } finally {
      listener.stop(true)
    }
  })

  test("returns an error for an accepted POST whose reply embeds a widget shell", async () => {
    let submissions = 0
    let checkouts = 0
    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "POST") submissions++
        return new Response(
          '<html><body><form><div class="cf-turnstile" data-sitekey="site"></div></form></body></html>',
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    await expect(
      scrape(
        submission(origin),
        localDeps(origin, () => {
          checkouts++
        }),
      ),
    ).rejects.toThrow("POST replay turnstile-shell; the request was not resent")
    expect(submissions).toBe(1)
    expect(checkouts).toBe(0)
  })

  test("does not resend an opted-in POST whose redirect target is challenged", async () => {
    const hops: string[] = []
    let checkouts = 0
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        hops.push(`${request.method} ${path}`)
        if (path === "/submit") return new Response(null, { status: 303, headers: { location: "/done" } })
        return new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } })
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    await expect(
      scrape(
        submission(origin),
        localDeps(origin, () => {
          checkouts++
        }),
      ),
    ).rejects.toThrow("POST replay cloudflare-challenge; the request was not resent")
    expect(hops).toEqual(["POST /submit", "GET /done"])
    expect(checkouts).toBe(0)
  })

  test("does not fall back for a generic 403 reply to an opted-in POST", async () => {
    let submissions = 0
    let checkouts = 0
    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "POST") submissions++
        return new Response("<html><body>Forbidden</body></html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        })
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    await expect(
      scrape(
        submission(origin),
        localDeps(origin, () => {
          checkouts++
        }),
      ),
    ).rejects.toThrow("POST replay http-403; the request was not resent")
    expect(submissions).toBe(1)
    expect(checkouts).toBe(0)
  })

  test.each([
    {
      status: 403,
      html: "<html><title>Please wait</title><body>Submission recorded</body></html>",
      applicationResponse: false,
    },
    {
      status: 503,
      html: "<html><title>Please wait</title><body>Submission recorded</body></html>",
      applicationResponse: false,
    },
    {
      status: 503,
      html: "<html><body><!-- window._cf_chl_opt = {} -->Submission recorded</body></html>",
      applicationResponse: true,
    },
    {
      status: 503,
      html: "<html><body><pre>window._cf_chl_opt = {}</pre>Submission recorded</body></html>",
      applicationResponse: true,
    },
    {
      status: 503,
      html: '<html><body><script type="application/json">{"_cf_chl_opt":{}}</script>Submission recorded</body></html>',
      applicationResponse: true,
    },
    {
      status: 503,
      html: '<html><body><script type="module;example">window._cf_chl_opt={}</script>Submission recorded</body></html>',
      applicationResponse: true,
    },
  ])(
    "does not resend an accepted POST with ambiguous or inert challenge markers: %j",
    async ({ status, html, applicationResponse }) => {
      let submissions = 0
      let checkouts = 0
      server = Bun.serve({
        port: 0,
        fetch(request) {
          if (request.method === "POST") submissions++
          return new Response(html, {
            status,
            headers: { "content-type": "text/html" },
          })
        },
      })
      const origin = `http://127.0.0.1:${server.port}`
      const result = scrape(
        submission(origin),
        localDeps(origin, () => {
          checkouts++
        }),
        {
          tier2: async (url, _handle, _session, _budget, headers, method, body) => {
            await fetch(url, { method, body, headers })
            return { tier: 2, status: "success", durationMs: 1, html: "Resent" }
          },
        },
      )
      if (applicationResponse) {
        const response = await result
        expect(response.tier).toBe(1)
        expect(response.statusCode).toBe(status)
        expect(response.html).toContain("Submission recorded")
      } else await expect(result).rejects.toThrow("not resent")
      expect(submissions).toBe(1)
      expect(checkouts).toBe(0)
    },
  )

  test("does not resend after an ambiguous browser fallback outcome", async () => {
    let submissions = 0
    const attempts: number[] = []
    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "POST") submissions++
        return submissions === 1 ? challengePage() : new Response("Submission recorded")
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    await expect(
      scrape(
        submission(origin),
        localDeps(origin, () => {}),
        {
          tier2: async (url, _handle, _session, _budget, headers, method, body) => {
            attempts.push(2)
            await (await fetch(url, { method, body, headers })).text()
            return { tier: 2, status: "error", durationMs: 1, reason: "browser connection closed after submission" }
          },
          tier3: async (url, _handle, _budget, _proxy, headers, method, body) => {
            attempts.push(3)
            const response = await fetch(url, { method, body, headers })
            return { tier: 3, status: "success", durationMs: 1, html: await response.text() }
          },
        },
      ),
    ).rejects.toThrow("not resent")
    expect(submissions).toBe(2)
    expect(attempts).toEqual([2])
  })

  test.each([422, 500])("preserves an application HTTP %s response without resending", async (status) => {
    let submissions = 0
    server = Bun.serve({
      port: 0,
      fetch() {
        submissions++
        return new Response('{"error":"Application reply"}', {
          status,
          headers: { "content-type": "application/json" },
        })
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    const result = await scrape(submission(origin), localDeps(origin))
    expect(result.statusCode).toBe(status)
    expect(JSON.parse(result.html)).toEqual({ error: "Application reply" })
    expect(submissions).toBe(1)
  })
})
