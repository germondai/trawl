import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import net, { type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTier1 } from "../../../packages/tiers/src/tiers/1"
import { probeLandingHost } from "../../../packages/tiers/src/utils/crossedLanding"
import { publicEgress } from "./deps"
import { MitmCa } from "./proxy/ca"
import { registerLocalProxy } from "./proxy/localTrust"
import { PublicEgressProxy } from "./public-egress"

async function tcp(port: number | undefined): Promise<Socket> {
  if (!port) throw new Error("Fixture is not listening")
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1")
    socket.on("error", () => {})
    socket.once("error", reject).once("connect", () => resolve(socket))
  })
}

describe("public destination egress", () => {
  test("recognized local MITM upstreams are rejected before opening a guarded connection", async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No fixture port")
    const unregister = registerLocalProxy({ server, configuredPort: address.port, ca: "owned CA" })
    try {
      for (const host of [
        "127.0.0.1",
        "127.0.0.2",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "0.0.0.0",
        "[::]",
        "[::ffff:0.0.0.0]",
      ]) {
        await expect(publicEgress.proxyFor(`http://${host}:${address.port}`)).rejects.toThrow("intercepting MITM")
      }
    } finally {
      unregister()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  test("route cache eviction preserves active credentials and forged tokens fail closed", async () => {
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owned") })
    const seen: (string | undefined)[] = []
    const proxy = new PublicEgressProxy({
      connect: async (_ip, _port, upstream) => {
        seen.push(upstream)
        return tcp(origin.port)
      },
    })
    try {
      const upstream = "http://operator:owned-password@proxy.example:8080"
      const first = await proxy.proxyFor(upstream)
      for (let i = 0; i < 513; i++) await proxy.proxyFor(`http://proxy-${i}.example:8080`)
      expect(await (await fetch("http://1.1.1.1/", { proxy: first })).text()).toBe("owned")
      expect(seen).toEqual([upstream])
      const forged = new URL(first)
      const token = Buffer.from(forged.password, "base64url")
      token[0] ^= 1
      forged.password = token.toString("base64url")
      expect((await fetch("http://1.1.1.1/", { proxy: forged.href })).status).toBe(407)
      expect(seen).toHaveLength(1)
    } finally {
      await proxy.close()
      await origin.stop(true)
    }
  })
  test("the selected Tier 1 transport uses guarded egress without changing origin proxy metadata", async () => {
    const html = `<html><head><title>Owned</title></head><body>${"Public egress fixture content. ".repeat(12)}</body></html>`
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
    })
    let connects = 0
    const proxy = new PublicEgressProxy({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      connect: async (ip) => {
        expect(ip).toBe("1.1.1.1")
        connects++
        return tcp(origin.port)
      },
    })
    try {
      const result = await runTier1(
        "http://owned.example/",
        undefined,
        "GET",
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        4000,
        undefined,
        undefined,
        await proxy.proxyFor(),
      )
      expect(result.status, result.reason).toBe("success")
      expect(result.html).toContain("Public egress fixture content")
      expect(connects).toBe(1)
    } finally {
      await proxy.close()
      await origin.stop(true)
    }
  })
  test("the crossed-landing probe keeps guarded egress on redirects", async () => {
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    })
    let connects = 0
    const proxy = new PublicEgressProxy({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      connect: async (ip) => {
        expect(ip).toBe("1.1.1.1")
        connects++
        return tcp(origin.port)
      },
    })
    try {
      await probeLandingHost("http://owned.example/", {
        networkProxy: (upstream) => proxy.proxyFor(upstream),
        timeoutMs: 3000,
      })
      expect(connects).toBe(1)
    } finally {
      await proxy.close()
      await origin.stop(true)
    }
  })
  test("HTTPS retains end-to-end SNI and certificate verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trawl-egress-ca-"))
    const ca = new MitmCa(dir)
    const origin = https.createServer({ key: ca.leafKeyPem, cert: ca.leafCertPem("owned.example") }, (_req, res) =>
      res.end("owned TLS content"),
    )
    let servername = ""
    origin.on("secureConnection", (socket) => {
      servername = socket.servername || ""
    })
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve))
    const address = origin.address()
    if (!address || typeof address === "string") throw new Error("No TLS port")
    const proxy = new PublicEgressProxy({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      connect: async (ip) => {
        expect(ip).toBe("1.1.1.1")
        return tcp(address.port)
      },
    })
    try {
      const proxyUrl = await proxy.proxyFor()
      const response = await fetch("https://owned.example/", {
        proxy: proxyUrl,
        tls: { ca: ca.caCertPem },
        signal: AbortSignal.timeout(4000),
      })
      expect(await response.text()).toBe("owned TLS content")
      expect(servername).toBe("owned.example")
      await expect(
        fetch("https://other.example/", {
          proxy: proxyUrl,
          tls: { ca: ca.caCertPem },
          signal: AbortSignal.timeout(4000),
        }),
      ).rejects.toThrow()
      await expect(
        fetch("https://owned.example/", { proxy: proxyUrl, signal: AbortSignal.timeout(4000) }),
      ).rejects.toThrow()
    } finally {
      await proxy.close()
      origin.closeAllConnections()
      await new Promise<void>((resolve) => origin.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
  test("pins HTTP to the checked IP, preserves content and strips proxy credentials", async () => {
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => Response.json({ url: req.url, auth: req.headers.get("proxy-authorization") }),
    })
    const connected: string[] = []
    let lookups = 0
    const proxy = new PublicEgressProxy({
      lookup: async () => {
        lookups++
        return [{ address: "1.1.1.1", family: 4 }]
      },
      connect: async (address, port) => {
        connected.push(`${address}:${port}`)
        return tcp(origin.port)
      },
    })
    try {
      const url = await proxy.proxyFor()
      const response = await fetch("http://owned.example:8080/test?x=1", {
        proxy: url,
        signal: AbortSignal.timeout(4000),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ url: "http://owned.example:8080/test?x=1", auth: null })
      expect(lookups).toBe(1)
      expect(connected).toEqual(["1.1.1.1:8080"])
      expect(await proxy.proxyFor()).toBe(url)
    } finally {
      await proxy.close()
      await origin.stop(true)
    }
  })

  test("a later private DNS answer never reaches the connector", async () => {
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owned") })
    let lookups = 0
    let connects = 0
    const proxy = new PublicEgressProxy({
      lookup: async () => [{ address: ++lookups === 1 ? "1.1.1.1" : "127.0.0.1", family: 4 }],
      connect: async () => {
        connects++
        return tcp(origin.port)
      },
    })
    try {
      const url = await proxy.proxyFor()
      expect(await (await fetch("http://rebind.example/first", { proxy: url })).text()).toBe("owned")
      const denied = await fetch("http://rebind.example/second", { proxy: url, signal: AbortSignal.timeout(3000) })
      expect(denied.status).toBe(400)
      expect(connects).toBe(1)
      expect(lookups).toBe(2)
    } finally {
      await proxy.close()
      await origin.stop(true)
    }
  })

  test("rejects mixed public/private DNS, literal private targets and missing proxy credentials", async () => {
    let connects = 0
    const proxy = new PublicEgressProxy({
      lookup: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      connect: async () => {
        connects++
        throw new Error("must not connect")
      },
    })
    try {
      const url = await proxy.proxyFor()
      for (const target of ["http://mixed.example/", "http://[::ffff:127.0.0.1]/", "http://127.0.0.1/"]) {
        const result = await fetch(target, { proxy: url, signal: AbortSignal.timeout(3000) })
        expect(result.status).toBe(400)
      }
      const withoutAuth = new URL(url)
      withoutAuth.username = ""
      withoutAuth.password = ""
      expect((await fetch("http://owned.example", { proxy: withoutAuth.href })).status).toBe(407)
      expect(connects).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  test("CONNECT passes raw bytes to a pinned IP and retains the configured upstream", async () => {
    const peers = new Set<Socket>()
    const echo = net.createServer((socket) => {
      peers.add(socket)
      socket.once("close", () => peers.delete(socket))
      socket.pipe(socket)
    })
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve))
    const address = echo.address()
    if (!address || typeof address === "string") throw new Error("No echo port")
    const seen: unknown[] = []
    const proxy = new PublicEgressProxy({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      connect: async (ip, port, upstream) => {
        seen.push({ ip, port, upstream })
        return tcp(address.port)
      },
    })
    try {
      const url = new URL(await proxy.proxyFor("socks5://operator:password@proxy.example:1080"))
      const socket = await tcp(Number(url.port))
      const auth = Buffer.from(`${url.username}:${url.password}`).toString("base64")
      const received = new Promise<string>((resolve, reject) => {
        let text = ""
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error("Tunnel test timed out"))
        }, 4000)
        socket.on("data", (chunk) => {
          text += chunk.toString()
          if (text.includes("owned-bytes")) {
            clearTimeout(timer)
            resolve(text)
          }
        })
        socket.once("error", reject)
      })
      socket.write(
        `CONNECT owned.example:443 HTTP/1.1\r\nHost: owned.example:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\nowned-bytes`,
      )
      expect(await received).toContain("200 Connection Established\r\n\r\nowned-bytes")
      expect(seen).toEqual([{ ip: "1.1.1.1", port: 443, upstream: "socks5://operator:password@proxy.example:1080" }])
      socket.destroy()
    } finally {
      await proxy.close()
      for (const peer of peers) peer.destroy()
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
  })

  test("CONNECT denial and connection failure close without a direct fallback", async () => {
    let connects = 0
    const proxy = new PublicEgressProxy({
      connect: async () => {
        connects++
        throw new Error("refused")
      },
    })
    try {
      const url = new URL(await proxy.proxyFor())
      for (const target of ["[::ffff:127.0.0.1]:443", "1.1.1.1:443"]) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request({
            hostname: "127.0.0.1",
            port: url.port,
            method: "CONNECT",
            path: target,
            headers: {
              "proxy-authorization": `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`,
            },
          })
          req.once("connect", (res, socket) => {
            socket.destroy()
            resolve(res.statusCode ?? 0)
          })
          req.once("error", reject)
          req.end()
        })
        expect(status).toBe(target.startsWith("[") ? 400 : 502)
      }
      expect(connects).toBe(1)
    } finally {
      await proxy.close()
    }
  })
})
