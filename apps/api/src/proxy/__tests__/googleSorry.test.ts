import { afterAll, describe, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserHandle } from "@trawl/browser"
import { directForwardHttp } from "../directForward"
import { isGoogleSorryRedirect } from "../googleSorry"
import { shutdownMitmProxy, startMitmProxy } from "../server"

const dir = mkdtempSync(join(tmpdir(), "trawl-google-sorry-test-"))
const redirectBody = "Redirecting."
const solvedHtml = `<html><body>${"Search result. ".repeat(20)}</body></html>`
const origin = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const params = new URL(req.url).searchParams
    return new Response(redirectBody, {
      status: Number(params.get("status") ?? 302),
      headers: {
        Location:
          params.get("location") ?? "https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch",
        "Content-Type": params.get("type") ?? "text/html",
      },
    })
  },
})
afterAll(() => {
  origin.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

function fixture(location: string, status = 302, type = "text/html"): string {
  const url = new URL(origin.url)
  url.search = new URLSearchParams({ location, status: String(status), type }).toString()
  return url.href
}

describe("Google sorry redirects", () => {
  test.each([
    "/sorry/index?continue=/search",
    "sorry/index",
    "//ipv6.google.com/sorry/index",
    "https://google.com/sorry",
  ])("resolves the challenge destination %s against the request URL", (location) => {
    expect(isGoogleSorryRedirect(302, location, "https://www.google.com/search")).toBe(true)
  })

  test.each([
    [200, "https://www.google.com/sorry/index"],
    [304, "https://www.google.com/sorry/index"],
    [302, undefined],
    [302, "https://[malformed"],
    [302, "ftp://www.google.com/sorry/index"],
    [302, "https://www.google.com:8443/sorry/index"],
    [302, "https://user:password@www.google.com/sorry/index"],
    [302, "https://accounts.google.com/sorry/index"],
  ] as const)("does not classify status %s and location %s as a search challenge", (status, location) => {
    expect(isGoogleSorryRedirect(status, location, "https://www.google.com/search")).toBe(false)
  })

  test.each([301, 302, 303, 307, 308])("detects a %i redirect to the Google challenge", async (status) => {
    const result = await directForwardHttp({
      url: fixture("https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch", status),
      method: "GET",
      headers: {},
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(status)
    expect(result.challengeDetected).toBe(true)
  })

  test("recognizes the redirect before binary streaming", async () => {
    const result = await directForwardHttp({
      url: fixture("https://ipv4.google.com/sorry/index", 302, "video/mp4"),
      method: "GET",
      headers: {},
    })
    if (result.mode === "stream") result.socket.destroy()
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.challengeDetected).toBe(true)
  })

  test.each([
    "https://www.google.com/search?q=trawl",
    "https://accounts.google.com/ServiceLogin",
    "https://www.google.com/sorry-not-a-challenge",
    "https://www.google.com.evil.test/sorry/index",
    "https://google.com@evil.test/sorry/index",
    "https://example.test/sorry/index",
    "https://example.test/?next=https://www.google.com/sorry/index",
    "/sorry/index",
  ])("preserves an ordinary or unrelated redirect to %s", async (location) => {
    const result = await directForwardHttp({ url: fixture(location), method: "GET", headers: {} })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(302)
    expect(result.headers.location).toBe(location)
    expect(result.body.toString()).toBe(redirectBody)
    expect(result.challengeDetected).toBe(false)
  })

  test("does not inspect redirects when challenge detection is disabled", async () => {
    const result = await directForwardHttp({
      url: fixture("https://www.google.com/sorry/index"),
      method: "GET",
      headers: {},
      skipChallengeDetection: true,
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.challengeDetected).toBe(false)
    expect(result.body.toString()).toBe(redirectBody)
  })

  test.each(["unavailable", "success", "persistent"] as const)(
    "enters the browser pipeline when the browser is %s",
    async (outcome) => {
      let acquired = 0
      const navigations: string[] = []
      const url = fixture("https://www.google.com/sorry/index")
      const mainFrame = {}
      const page = {
        url: () => (outcome === "persistent" ? "https://www.google.com/sorry/index" : url),
        title: async () => "Search results",
        content: async () => solvedHtml,
        goto: async (target: string) => {
          navigations.push(target)
        },
        on: (event: string, handler: (response: unknown) => void) => {
          if (event !== "response") return
          handler({
            url: () => url,
            status: () => 200,
            headers: () => ({ "content-type": "text/html" }),
            allHeaders: async () => ({ "content-type": "text/html" }),
            body: async () => Buffer.from(solvedHtml),
            request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
          })
        },
        off: () => {},
        once: () => {},
        mainFrame: () => mainFrame,
        frames: () => [],
        context: () => ({ cookies: async () => [] }),
        evaluate: async () => "test-agent",
        setExtraHTTPHeaders: async () => {},
        waitForLoadState: async () => {},
        close: async () => {},
      }
      const handle: BrowserHandle = {
        id: 1,
        lease: 1,
        headful: false,
        context: { newPage: async () => page, addCookies: async () => {}, cookies: async () => [] },
        browser: {},
        fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
      }
      const proxy = startMitmProxy({
        port: 0,
        host: "127.0.0.1",
        caDir: dir,
        maxTier: 2,
        maxTimeout: 1000,
        deps: {
          minTier: 2,
          acquireBrowser: async () => {
            acquired++
            if (outcome === "unavailable") throw new Error("Test browser unavailable")
            return handle
          },
          releaseBrowser: () => {},
          loadSession: async () => ({ cookies: [], userAgent: "test-agent", savedAt: 1 }),
          saveSession: async () => {},
          invalidateSession: async () => {},
        },
      })
      try {
        if (!proxy.server.listening) await once(proxy.server, "listening")
        const address = proxy.server.address()
        if (!address || typeof address === "string") throw new Error("No proxy address")
        const response = await new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
          (resolve, reject) => {
            const request = http.request(
              {
                hostname: "127.0.0.1",
                port: address.port,
                path: url,
                agent: false,
                headers: { Connection: "close" },
              },
              (response) => {
                const chunks: Buffer[] = []
                response.on("data", (chunk: Buffer) => chunks.push(chunk))
                response.on("error", reject)
                response.on("end", () =>
                  resolve({
                    status: response.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString(),
                    headers: response.headers,
                  }),
                )
              },
            )
            request.on("error", reject)
            request.setTimeout(3000, () => request.destroy(new Error("Proxy test timed out")))
            request.end()
          },
        )
        expect(acquired).toBe(1)
        expect(response.status).toBe(outcome === "unavailable" ? 502 : 200)
        if (outcome === "success") {
          expect(navigations).toEqual([url])
          expect(response.body).toBe(solvedHtml)
        }
        if (outcome === "persistent") {
          expect(response.headers["x-trawl-status"]).toBe("blocked")
          expect(response.headers["x-trawl-reason"]).toBe("google-sorry-persistent")
          expect(navigations).toEqual([url])
        }
      } finally {
        await shutdownMitmProxy(proxy)
      }
    },
  )
})
