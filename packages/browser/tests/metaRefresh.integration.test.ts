import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import { scrape } from "../../tiers/src/orchestrator"
import { followMetaRefresh } from "../../tiers/src/utils/metaRefresh"
import { installOutboundPolicy } from "../../tiers/src/utils/outboundPolicy"
import type { BrowserHandle } from "../src/index"
import { launchAnubisBrowser } from "./helpers/anubisBrowser"

// Run explicitly with TRAWL_BROWSER_TESTS=1 after installing Camoufox. The fixture
// uses local hosts and a simulated challenge, never an external protected website.
describe.skipIf(process.env.TRAWL_BROWSER_TESTS !== "1")("Camoufox meta refresh integration", () => {
  let browser: Browser
  let server: ReturnType<typeof Bun.serve>
  let handle: BrowserHandle
  const body = `<html><head><title>Destination</title></head><body>${"Real destination content ".repeat(20)}</body></html>`
  const hits: string[] = []
  const url = (path: string, host = "localhost") => `http://${host}:${server.port}${path}`

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const target = new URL(request.url)
        hits.push(target.hostname + target.pathname)
        if (target.pathname === "/slow-final") {
          await Bun.sleep(250)
          return new Response(body, { headers: { "Content-Type": "text/html" } })
        }
        if (target.pathname === "/final") return new Response(body, { headers: { "Content-Type": "text/html" } })
        if (target.pathname === "/challenge") {
          if (request.headers.get("cookie")?.includes("cf_clearance=fixture-clearance")) {
            return new Response(body, { headers: { "Content-Type": "text/html" } })
          }
          return new Response(
            `<html><head><title>Just a moment</title></head><body>
            <script>window._cf_chl_opt = {}; document.cookie = 'cf_clearance=fixture-clearance; path=/';</script>
            ${"Challenge fixture ".repeat(20)}</body></html>`,
            { headers: { "Content-Type": "text/html" } },
          )
        }
        if (target.pathname === "/fallback-race") {
          return new Response(`<meta http-equiv="refresh" content="0; ${url("/slow-final", "127.0.0.1")}">`, {
            headers: { "Content-Type": "text/html", "Content-Security-Policy": "sandbox allow-same-origin" },
          })
        }
        const delay = target.pathname === "/delayed" ? 1 : 0
        const destination = url(target.pathname === "/protected" ? "/challenge" : "/final", "127.0.0.1")
        return new Response(
          `<html><head><meta http-equiv="refresh" content="${delay}; url=${destination}"></head><body>Forwarding</body></html>`,
          {
            headers: { "Content-Type": "text/html" },
          },
        )
      },
    })
    browser = await launchAnubisBrowser()
    const context = await browser.newContext({ viewport: null })
    handle = {
      id: 1,
      lease: 1,
      headful: false,
      browser,
      context,
      fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    server?.stop(true)
  })

  for (const path of ["/immediate", "/delayed"]) {
    test(`native scraping follows ${path} across hosts and records the destination`, async () => {
      const result = await scrape(
        { url: url(path), followMetaRefresh: true, maxTier: 3, maxTimeout: 15_000, redirectChain: true },
        {
          acquireBrowser: async () => handle,
          releaseBrowser: () => {},
          loadSession: async () => undefined,
          saveSession: async () => {},
          invalidateSession: async () => {},
        },
      )
      expect(result.tier).toBe(3)
      expect(result.url).toBe(url("/final", "127.0.0.1"))
      expect(result.html).toContain("Real destination content")
      expect(result.redirectChain).toContain(url("/final", "127.0.0.1"))
    }, 20_000)
  }

  test("repeated immediate redirects tolerate navigation during DOM reads", async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const page = await handle.context.newPage()
      try {
        await page.goto(url("/immediate"), { waitUntil: "domcontentloaded" })
        expect(await followMetaRefresh(page as any, 5000)).toEqual({ status: "ok", url: url("/final", "127.0.0.1") })
        expect(await page.content()).toContain("Real destination content")
      } finally {
        await page.close()
      }
    }
  }, 60_000)

  test("an interrupted fallback waits for the competing destination navigation", async () => {
    const page = await handle.context.newPage()
    let competing: Promise<unknown> | undefined
    try {
      await page.goto(url("/fallback-race"), { waitUntil: "domcontentloaded" })
      const goto = page.goto.bind(page)
      page.goto = (target: string, options?: Parameters<typeof goto>[1]) => {
        const started = page.waitForEvent("request", {
          predicate: (request: import("playwright-core").Request) =>
            request.isNavigationRequest() && request.url() === target,
          timeout: 5000,
        })
        const first = goto(target, options)
        competing = started.then(() => goto(target, options))
        void competing?.catch(() => {})
        return first
      }
      expect(await followMetaRefresh(page as any, 5000)).toEqual({ status: "ok", url: url("/slow-final", "127.0.0.1") })
      await competing
      expect(await page.content()).toContain("Real destination content")
    } finally {
      await page.close()
    }
  }, 10_000)

  test("a browser network error page is not a successful destination", async () => {
    const page = await handle.context.newPage()
    try {
      await page
        .goto("http://127.0.0.1:1/unreachable", { waitUntil: "domcontentloaded", timeout: 2000 })
        .catch(() => {})
      expect(await followMetaRefresh(page as any, 3000)).toEqual({
        status: "error",
        reason: "meta-refresh-navigation-failed",
      })
    } finally {
      await page.close()
    }
  }, 10_000)

  test("cached browser tier follows a delayed refresh", async () => {
    const result = await scrape(
      { url: url("/delayed"), followMetaRefresh: true, maxTier: 2, maxTimeout: 15_000 },
      {
        acquireBrowser: async () => handle,
        releaseBrowser: () => {},
        loadSession: async () => ({ cookies: [], userAgent: "test-agent", savedAt: Date.now() }),
        saveSession: async () => {},
        invalidateSession: async () => {},
      },
    )
    expect(result.tier).toBe(2)
    expect(result.url).toBe(url("/final", "127.0.0.1"))
    expect(result.html).toContain("Real destination content")
  }, 20_000)

  test("cross-host clearance and challenge fallback stay on the destination", async () => {
    hits.length = 0
    const result = await scrape(
      { url: url("/protected"), followMetaRefresh: true, maxTier: 3, maxTimeout: 20_000 },
      {
        acquireBrowser: async () => handle,
        releaseBrowser: () => {},
        loadSession: async () => undefined,
        saveSession: async () => {},
        invalidateSession: async () => {},
      },
    )
    expect(result.url).toBe(url("/challenge", "127.0.0.1"))
    expect(result.html).toContain("Real destination content")
    expect(hits.filter((hit) => hit === "127.0.0.1/challenge").length).toBeGreaterThanOrEqual(2)
    // Once in HTTP and once in the browser; challenge fallback must not return here.
    expect(hits.filter((hit) => hit === "localhost/protected")).toHaveLength(2)
  }, 25_000)

  test("outbound routing blocks an automatic refresh to a rejected host", async () => {
    const context = await browser.newContext({ viewport: null })
    try {
      const page = await context.newPage()
      await installOutboundPolicy(page, async (target) => {
        if (new URL(target).hostname === "127.0.0.1") throw new Error("fixture outbound rejection")
      })
      hits.length = 0
      await page.goto(url("/delayed"), { waitUntil: "domcontentloaded" })
      const result = await followMetaRefresh(page as any, 3000, async (target) => {
        if (new URL(target).hostname === "127.0.0.1") throw new Error("fixture outbound rejection")
      })
      expect(result.status).toBe("error")
      await page.waitForTimeout(1200)
      expect(hits).not.toContain("127.0.0.1/final")
    } finally {
      await context.close()
    }
  }, 10_000)
})
