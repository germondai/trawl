import { afterAll, describe, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestratorDeps } from "@trawl/tiers"
import { type MitmProxyOptions, shutdownMitmProxy, startMitmProxy } from "../server"

const caDir = mkdtempSync(join(tmpdir(), "trawl-forwarding-test-"))
afterAll(() => rmSync(caDir, { recursive: true, force: true }))

const deps: OrchestratorDeps = {
  acquireBrowser: async () => {
    throw new Error("This test must not acquire a browser")
  },
  releaseBrowser() {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
  wafDetectionEnabled: false,
}

async function withProxy<T>(run: (port: number) => Promise<T>, options: Partial<MitmProxyOptions> = {}) {
  const proxy = startMitmProxy({
    host: "127.0.0.1",
    port: 0,
    caDir,
    maxTier: 1,
    maxTimeout: 1000,
    deps,
    ...options,
  })
  try {
    if (!proxy.server.listening) await once(proxy.server, "listening")
    const address = proxy.server.address() as net.AddressInfo
    return await run(address.port)
  } finally {
    await shutdownMitmProxy(proxy, 100)
  }
}

function request(port: number, url: string, method = "GET", headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("error", reject)
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      )
    })
    req.on("error", reject)
    req.setTimeout(2000, () => req.destroy(new Error("Proxy request timed out")))
    req.end(body)
  })
}

describe("proxy request lifecycle", () => {
  test("does not replay a POST after the origin accepted it but returned an invalid response", async () => {
    let commits = 0
    const origin = net.createServer((socket) => {
      let input = ""
      socket.on("data", (data) => {
        input += data.toString()
        if (!input.endsWith("\r\n\r\nx")) return
        commits++
        socket.end(
          commits === 1 ? "INVALID\r\n\r\n" : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
        )
      })
    })
    origin.listen(0, "127.0.0.1")
    await once(origin, "listening")
    try {
      await withProxy(async (port) => {
        const reply = await request(
          port,
          `http://127.0.0.1:${(origin.address() as net.AddressInfo).port}/commit`,
          "POST",
          { "content-type": "text/plain", "content-length": "1" },
          "x",
        )
        expect(commits).toBe(1)
        expect(reply.status).toBe(502)
        expect(reply.headers["proxy-status"]).toContain("error=http_protocol_error")
      })
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()))
    }
  })

  test("keeps caller cookies separate from shared HTTP clearance", async () => {
    let cookie: string | null = null
    let cacheReads = 0
    const origin = Bun.serve({
      port: 0,
      fetch(req) {
        cookie = req.headers.get("cookie")
        return new Response("authenticated content", { headers: { "content-type": "text/plain" } })
      },
    })
    try {
      await withProxy(
        async (port) => {
          const reply = await request(port, origin.url.href, "GET", {
            cookie: "session=fixture",
            "user-agent": "fixture-agent",
          })
          expect(reply.status).toBe(200)
          expect(cookie).toContain("session=fixture")
          expect(cookie).not.toContain("cf_clearance=cached")
          expect(cacheReads).toBe(0)
        },
        {
          alwaysScrape: true,
          deps: {
            ...deps,
            loadSession: async () => {
              cacheReads++
              return {
                userAgent: "fixture-agent",
                savedAt: Date.now(),
                httpOrigin: origin.url.origin,
                cookies: [
                  {
                    name: "cf_clearance",
                    value: "cached",
                    domain: origin.url.hostname,
                    path: "/",
                    expires: -1,
                    secure: false,
                    httpOnly: true,
                  },
                ],
              }
            },
          },
        },
      )
    } finally {
      origin.stop(true)
    }
  })

  test("does not forward Authorization through browser redirect header overrides", async () => {
    let acquired = 0
    const origin = Bun.serve({
      port: 0,
      fetch: () => new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    })
    try {
      await withProxy(
        async (port) => {
          const reply = await request(port, origin.url.href, "GET", { authorization: "Bearer fixture" })
          expect(reply.status).toBe(502)
          expect(reply.body).toContain("Authorization")
          expect(acquired).toBe(0)
        },
        {
          alwaysScrape: true,
          maxTier: 3,
          deps: {
            ...deps,
            acquireBrowser: async () => {
              acquired++
              throw new Error("Browser must not receive Authorization")
            },
          },
        },
      )
    } finally {
      origin.stop(true)
    }
  })

  test("preserves HEAD representation metadata without reading or sending a body", async () => {
    const origin = Bun.serve({ port: 0, fetch: () => new Response("twelve bytes", { headers: { etag: '"head"' } }) })
    try {
      await withProxy(async (port) => {
        const reply = await request(port, origin.url.href, "HEAD")
        expect(reply.status).toBe(200)
        expect(reply.headers["content-length"]).toBe("12")
        expect(reply.headers.etag).toBe('"head"')
        expect(reply.body).toBe("")
      })
    } finally {
      origin.stop(true)
    }
  })

  test("retains trusted client credentials during escalation and drops them across origins", async () => {
    const received: { path: string; auth: string | null; cookie: string | null; ua: string | null }[] = []
    const target = Bun.serve({
      port: 0,
      fetch(req) {
        received.push({
          path: "target",
          auth: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
          ua: req.headers.get("user-agent"),
        })
        return new Response("target")
      },
    })
    const origin = Bun.serve({
      port: 0,
      fetch(req) {
        received.push({
          path: "origin",
          auth: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
          ua: req.headers.get("user-agent"),
        })
        return new Response(null, { status: 302, headers: { location: target.url.href } })
      },
    })
    try {
      await withProxy(
        async (port) => {
          const reply = await request(port, origin.url.href, "GET", {
            authorization: "Bearer fixture",
            cookie: "session=fixture",
            "user-agent": "fixture-agent",
          })
          expect(reply.status).toBe(200)
          expect(received).toEqual([
            { path: "origin", auth: "Bearer fixture", cookie: "session=fixture", ua: "fixture-agent" },
            { path: "target", auth: null, cookie: null, ua: "fixture-agent" },
          ])
        },
        { alwaysScrape: true },
      )
    } finally {
      origin.stop(true)
      target.stop(true)
    }
  })

  test("accepts a CONNECT request split inside its method", async () => {
    await withProxy(async (port) => {
      const client = net.connect(port, "127.0.0.1")
      client.on("error", () => {})
      try {
        await once(client, "connect")
        const response = new Promise<string>((resolve, reject) => {
          client.once("data", (data) => resolve(data.toString()))
          client.once("close", () => reject(new Error("CONNECT closed without a response")))
          client.setTimeout(1000, () => reject(new Error("CONNECT timed out")))
        })
        client.write("CON")
        await Bun.sleep(10)
        client.write("NECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n")
        expect(await response).toStartWith("HTTP/1.1 200 Connection Established")
      } finally {
        client.destroy()
      }
    })
  })

  test("closes a buffered origin response when the downstream client disconnects", async () => {
    const sockets = new Set<net.Socket>()
    let upstreamClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve
    })
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const origin = net.createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => {
        sockets.delete(socket)
        upstreamClosed()
      })
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n")
        ready()
      })
    })
    origin.listen(0, "127.0.0.1")
    await once(origin, "listening")
    try {
      await withProxy(async (port) => {
        const client = net.connect(port, "127.0.0.1")
        client.on("error", () => {})
        try {
          await once(client, "connect")
          const originPort = (origin.address() as net.AddressInfo).port
          client.write(`GET http://127.0.0.1:${originPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`)
          await started
          client.destroy()
          await Promise.race([closed, Bun.sleep(500)])
          expect(sockets.size).toBe(0)
        } finally {
          client.destroy()
        }
      })
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => origin.close(() => resolve()))
    }
  })
})
