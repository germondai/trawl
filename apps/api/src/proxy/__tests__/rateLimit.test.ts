import { afterAll, describe, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserHandle } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { shutdownMitmProxy, startMitmProxy } from "../server"

const dir = mkdtempSync(join(tmpdir(), "trawl-429-test-"))
const originalBody = "Please retry later."
const solvedHtml = `<html><body>${"Search result. ".repeat(20)}</body></html>`
const videoBody = Buffer.from([0, 255, 1, 2])
const origin = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    const status = path === "/ok" ? 200 : path.startsWith("/status/") ? Number(path.split("/")[2]) : 429
    const video = path === "/video" || path === "/video-delayed"
    let timer: ReturnType<typeof setTimeout> | undefined
    const delayed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(videoBody.subarray(0, 2))
        timer = setTimeout(() => {
          controller.enqueue(videoBody.subarray(2))
          controller.close()
        }, 80)
      },
      cancel() {
        clearTimeout(timer)
      },
    })
    if (path !== "/video-delayed") void delayed.cancel()
    return new Response(path === "/video-delayed" ? delayed : video ? videoBody : originalBody, {
      status,
      headers: {
        "content-type": video ? "video/mp4" : "text/plain; charset=utf-8",
        ...(video ? { "content-length": String(videoBody.length) } : {}),
        "retry-after": "60",
        "x-origin-response": "original",
      },
    })
  },
})
afterAll(() => {
  origin.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

function dependencies(outcome: "success" | "unavailable" | "blocked", acquired: string[]): OrchestratorDeps {
  const mainFrame = {}
  const page = {
    url: () => `${origin.url}limited`,
    title: async () => "Search results",
    content: async () => (outcome === "blocked" ? originalBody : solvedHtml),
    goto: async () => {},
    on: (event: string, handler: (response: unknown) => void) => {
      if (event !== "response") return
      handler({
        url: () => `${origin.url}limited`,
        status: () => (outcome === "blocked" ? 429 : 200),
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
  return {
    minTier: 2,
    acquireBrowser: async () => {
      acquired.push("acquire")
      if (outcome === "unavailable") throw new Error("No browser available")
      return handle
    },
    releaseBrowser: () => {},
    loadSession: async () => ({ cookies: [], userAgent: "test-agent", savedAt: 1 }),
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
}

async function throughProxy(port: number, path: string): Promise<{ status: number; headers: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: `${origin.url}${path}`,
        agent: false,
        headers: { Host: origin.hostname, Connection: "close" },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", reject)
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: Object.entries(response.headers)
              .map(([name, value]) => `${name}: ${value}`)
              .join("\r\n")
              .toLowerCase(),
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    request.on("error", reject)
    request.setTimeout(3000, () => request.destroy(new Error("Proxy test timed out")))
    request.end()
  })
}

async function scenario(enabled: boolean | undefined, outcome: "success" | "unavailable" | "blocked", paths: string[]) {
  const acquired: string[] = []
  const proxy = startMitmProxy({
    port: 0,
    host: "127.0.0.1",
    caDir: dir,
    maxTier: 2,
    maxTimeout: 1000,
    deps: dependencies(outcome, acquired),
    ...{ escalate429: enabled },
  })
  try {
    if (!proxy.server.listening) await once(proxy.server, "listening")
    const address = proxy.server.address()
    if (!address || typeof address === "string") throw new Error("No proxy address")
    const responses = []
    for (const path of paths) responses.push(await throughProxy(address.port, path))
    return { responses, acquired }
  } finally {
    await shutdownMitmProxy(proxy)
  }
}

describe("opt-in HTTP 429 escalation", () => {
  test.each([undefined, false])("passes 429 through when the flag is %s", async (enabled) => {
    const { responses, acquired } = await scenario(enabled, "unavailable", ["limited"])
    expect(responses[0]?.status).toBe(429)
    expect(responses[0]?.headers).toContain("retry-after: 60")
    expect(responses[0]?.body.toString()).toBe(originalBody)
    expect(acquired).toEqual([])
  })
  test("escalates 429 when enabled without marking the whole host as challenged", async () => {
    const { responses, acquired } = await scenario(true, "success", ["limited", "ok"])
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body.toString()).toBe(solvedHtml)
    expect(responses[1]?.status).toBe(200)
    expect(responses[1]?.body.toString()).toBe(originalBody)
    expect(acquired).toEqual(["acquire"])
  })
  test.each(["unavailable", "blocked"] as const)(
    "preserves the original 429 when the browser is %s",
    async (outcome) => {
      const { responses, acquired } = await scenario(true, outcome, ["limited"])
      expect(acquired).toEqual(["acquire"])
      expect(responses[0]?.status).toBe(429)
      expect(responses[0]?.headers).toContain("retry-after: 60")
      expect(responses[0]?.headers).toContain("x-origin-response: original")
      expect(responses[0]?.body.toString()).toBe(originalBody)
    },
  )
  test.each(["video", "video-delayed"])(
    "escalates streamed 429 responses and preserves %s bytes on failure",
    async (path) => {
      const { responses, acquired } = await scenario(true, "unavailable", [path])
      expect(acquired).toEqual(["acquire"])
      expect(responses[0]?.status).toBe(429)
      expect(responses[0]?.headers).toContain("retry-after: 60")
      expect(responses[0]?.body).toEqual(videoBody)
    },
  )
  test("replaces a streamed 429 with the successful browser result", async () => {
    const { responses, acquired } = await scenario(true, "success", ["video-delayed"])
    expect(acquired).toEqual(["acquire"])
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body.toString()).toBe(solvedHtml)
  })
  test.each([200, 403, 503])("does not escalate an unrecognized %i response", async (status) => {
    const { responses, acquired } = await scenario(true, "unavailable", [`status/${status}`])
    expect(responses[0]?.status).toBe(status)
    expect(acquired).toEqual([])
  })
})
