import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { runTier1 } from "../src/tiers/1"
import {
  selectLatestFirefoxProfile,
  TIER1_USER_AGENT,
  TLS_PROFILE,
  tlsFetch,
  verifyTlsTransport,
} from "../src/utils/tlsTransport"

describe("native TLS transport", () => {
  test("selects the latest numbered Firefox profile regardless of catalogue order", () => {
    expect(
      selectLatestFirefoxProfile([
        "chrome_999",
        "firefox_99",
        "firefox_150",
        "firefox_148",
        "firefox_151_beta",
        "firefox_149_android",
      ]),
    ).toBe("firefox_150")
  })

  test("fails explicitly when no numbered Firefox profile is available", () => {
    expect(() => selectLatestFirefoxProfile([])).toThrow("No supported Firefox TLS profile")
    expect(() => selectLatestFirefoxProfile(["chrome_999", "firefox_150_beta"])).toThrow(
      "No supported Firefox TLS profile",
    )
  })

  test("keeps the User-Agent aligned with the selected native profile", async () => {
    const { getProfiles } = await import("node-wreq")
    expect(TLS_PROFILE).toBe(selectLatestFirefoxProfile(getProfiles()))
    const version = TLS_PROFILE.slice("firefox_".length)
    expect(TIER1_USER_AGENT).toBe(
      `Mozilla/5.0 (X11; Linux x86_64; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`,
    )
  })

  test("loads the native transport at startup", async () => {
    await verifyTlsTransport()
  })

  test("reuses healthy connections without retaining response cookies", async () => {
    const ports: number[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const address = server.requestIP(request)
        if (!address) throw new Error("Test request has no client address")
        ports.push(address.port)
        return new Response(request.headers.get("cookie") ?? "no cookie", {
          headers: { "set-cookie": "session=private" },
        })
      },
    })
    try {
      for (let index = 0; index < 3; index++) {
        const response = await tlsFetch(server.url.href)
        expect(await response.text()).toBe("no cookie")
      }
      expect(new Set(ports).size).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test("rejects an already aborted request", async () => {
    await expect(tlsFetch("https://example.invalid", { signal: AbortSignal.abort() })).rejects.toThrow("aborted")
  })

  test("enforces deadlines before response headers", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    })
    try {
      const started = Date.now()
      const error = await tlsFetch(server.url.href, { timeoutMs: 100 }).catch((error: unknown) => error)
      expect(String(error)).toMatch(/timed out|timeout/i)
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      server.stop(true)
    }
  })

  test("passes the shared request deadline signal through Tier 1", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    })
    try {
      const started = Date.now()
      const result = await runTier1(
        server.url.href,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        AbortSignal.timeout(100),
      )
      expect(result.status).toBe("error")
      expect(result.reason).toContain("aborted")
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      server.stop(true)
    }
  })

  test("bounds concurrent cancelled responses without blocking healthy requests", async () => {
    let active = 0
    let closed = 0
    let allClosed: () => void = () => {}
    const drained = new Promise<void>((resolve) => {
      allClosed = resolve
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/healthy") return new Response("healthy")
        active++
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
            },
            cancel() {
              active--
              if (++closed === 24) allClosed()
            },
          }),
        )
      },
    })
    try {
      await Promise.all(
        Array.from({ length: 24 }, async (_value, index) => {
          const mode = ["abort", "deadline", "cancel"][index % 3]
          const controller = new AbortController()
          const response = await tlsFetch(server.url.href, {
            signal: controller.signal,
            timeoutMs: 500,
          })
          if (!response.body) throw new Error("Test response has no body")
          const reader = response.body.getReader()
          const pending = (async () => {
            while (!(await reader.read()).done) {}
          })()
          if (mode === "cancel") {
            await reader.cancel()
            await pending
          } else {
            if (mode === "abort") controller.abort()
            const error = await pending.catch((error: unknown) => error)
            expect(String(error)).toContain(mode === "abort" ? "aborted" : "timed out")
          }
          const healthy = await tlsFetch(`${server.url}healthy`, { timeoutMs: 1000 })
          expect(await healthy.text()).toBe("healthy")
        }),
      )
      await drained
      expect(active).toBe(0)
      expect(closed).toBe(24)
    } finally {
      server.stop(true)
    }
  })

  test("keeps gzip bytes encoded while Tier 1 inspects decoded text", async () => {
    const encoded = gzipSync("hello from gzip")
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(encoded, { headers: { "content-encoding": "gzip", "content-type": "text/plain" } }),
    })
    try {
      const result = await runTier1(server.url.href)
      expect(result.status).toBe("success")
      expect(result.html).toBe("hello from gzip")
      expect(result.body).toEqual(new Uint8Array(encoded))
      expect(result.responseHeaders?.["content-encoding"]).toBe("gzip")
    } finally {
      server.stop(true)
    }
  })

  test("validates redirect hops and strips credentials without replaying response cookies", async () => {
    const destination = Bun.serve({
      port: 0,
      async fetch(request) {
        return Response.json({
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          contentType: request.headers.get("content-type"),
          method: request.method,
          body: await request.text(),
        })
      },
    })
    const origin = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: destination.url.href, "set-cookie": "session=upstream" },
        }),
    })
    try {
      const validated: string[] = []
      const result = await runTier1(
        origin.url.href,
        { authorization: "Bearer caller", cookie: "session=caller", "content-type": "text/plain" },
        "POST",
        "payload",
        undefined,
        async (url) => {
          validated.push(url)
        },
      )
      expect(result.status).toBe("success")
      expect(validated).toEqual([origin.url.href, destination.url.href])
      expect(JSON.parse(result.html ?? "")).toEqual({
        authorization: null,
        cookie: null,
        contentType: null,
        method: "GET",
        body: "",
      })
    } finally {
      origin.stop(true)
      destination.stop(true)
    }
  })

  test("returns duplicate cookies and binary bytes without following redirects", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/redirect")
          return new Response(null, { status: 302, headers: { location: "/body" } })
        const headers = new Headers()
        headers.append("set-cookie", "one=1")
        headers.append("set-cookie", "two=2")
        return new Response(new Uint8Array([0, 255, 1]), { headers })
      },
    })
    try {
      const redirect = await tlsFetch(`${server.url}redirect`)
      expect(redirect.status).toBe(302)
      await redirect.body?.cancel()
      const response = await tlsFetch(`${server.url}body`)
      expect(response.headers.getSetCookie()).toEqual(["one=1", "two=2"])
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]))
      const result = await runTier1(`${server.url}redirect`)
      expect(result.status).toBe("success")
      expect(result.effectiveUrl).toBe(`${server.url}body`)
      expect(result.body).toEqual(new Uint8Array([0, 255, 1]))
    } finally {
      server.stop(true)
    }
  })

  test("returns headers before a hanging body and supports cancellation", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
            },
          }),
          {
            status: 202,
            headers: { "x-amzn-waf-action": "challenge" },
          },
        )
      },
    })
    try {
      const response = await tlsFetch(server.url.href, { timeoutMs: 1500 })
      expect(response.headers.get("x-amzn-waf-action")).toBe("challenge")
      await response.body?.cancel()
      const result = await runTier1(server.url.href)
      expect(result.reason).toBe("aws-waf-challenge")
    } finally {
      server.stop(true)
    }
  })
})
