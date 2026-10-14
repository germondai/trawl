import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rootCertificates } from "node:tls"
import { gzipSync } from "node:zlib"
import { runTier1 } from "../src/tiers/1"
import { tier1Transport, tlsFetch } from "../src/utils/tlsTransport"

const originalFetch = tier1Transport.fetch

afterEach(() => {
  tier1Transport.fetch = originalFetch
})

describe("trusted proxy CA", () => {
  test("adds the private CA alongside public roots for only that fetch", async () => {
    let options: Parameters<typeof fetch>[1]
    tier1Transport.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      options = init
      return new Response("Pong", { headers: { "content-type": "text/plain" } })
    }) as typeof fetch

    const result = await runTier1(
      "https://target.example/ping",
      undefined,
      "GET",
      undefined,
      "http://127.0.0.1:8192",
      undefined,
      false,
      "TRAWL PRIVATE CA",
    )

    expect(result.status).toBe("success")
    const ca = (options as RequestInit & { tls?: { ca?: string[] } }).tls?.ca
    expect(ca).toContain("TRAWL PRIVATE CA")
    expect(ca).toContain(rootCertificates[0])
  })

  test("does not alter TLS options without recognized local proxy trust", async () => {
    let options: Parameters<typeof fetch>[1]
    tier1Transport.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      options = init
      return new Response("Pong", { headers: { "content-type": "text/plain" } })
    }) as typeof fetch

    await runTier1("https://target.example/ping", undefined, "GET", undefined, "http://proxy.example:8080")
    expect((options as RequestInit & { tls?: unknown }).tls).toBeUndefined()
  })
})

describe.skipIf(!Bun.which("openssl"))("native scoped CA trust", () => {
  let directory: string
  let ca: string
  let server: ReturnType<typeof Bun.serve>
  let proxy: ReturnType<typeof createServer>
  let proxyUrl: string
  const sockets = new Set<Socket>()
  const encoded = gzipSync(new Uint8Array([0, 255, 1, 2]))

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "clawk-native-ca-"))
    const keyFile = join(directory, "key.pem")
    const certFile = join(directory, "cert.pem")
    const generated = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ])
    if (!generated.success) throw new Error(generated.stderr.toString())
    ca = readFileSync(certFile, "utf8")
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(keyFile), cert: ca },
      fetch: () => new Response(encoded, { headers: { "content-encoding": "gzip" } }),
    })
    const serverPort = server.port
    if (serverPort === undefined) throw new Error("Test TLS server did not bind TCP")
    proxy = createServer((_request, response) => response.writeHead(502).end())
    proxy.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
    proxy.on("connect", (request, socket, head) => {
      if (request.url !== `localhost:${serverPort}`) return socket.destroy()
      const upstream = connect(serverPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      socket.on("close", () => upstream.destroy())
      socket.on("error", () => upstream.destroy())
      upstream.on("error", () => socket.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const address = proxy.address()
    if (!address || typeof address === "string") throw new Error("Proxy did not bind TCP")
    proxyUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(() => {
    for (const socket of sockets) socket.destroy()
    proxy?.close()
    server?.stop(true)
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  for (const viaProxy of [false, true]) {
    test(`preserves bytes and isolates trust ${viaProxy ? "through CONNECT" : "directly"}`, async () => {
      const url = `https://localhost:${server.port}/`
      const options = { timeoutMs: 1500, ...(viaProxy ? { proxy: proxyUrl } : {}) }
      for (let index = 0; index < 2; index++) {
        const response = await tlsFetch(url, { ...options, tls: { ca } })
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(encoded))
        expect(response.headers.get("content-encoding")).toBe("gzip")
        const error = await tlsFetch(url, options).catch((error: unknown) => error)
        expect(String(error)).toContain("CERTIFICATE_VERIFY_FAILED")
      }
    })
  }

  test("still rejects a hostname mismatch with a trusted issuer", async () => {
    const error = await tlsFetch(`https://127.0.0.1:${server.port}/`, {
      timeoutMs: 1500,
      tls: { ca },
    }).catch((error: unknown) => error)
    expect(String(error)).toContain("CERTIFICATE_VERIFY_FAILED")
  })
})
