import { afterAll, describe, expect, test } from "bun:test"
import { once } from "node:events"
import net from "node:net"
import { gzipSync } from "node:zlib"
import { directForwardHttp } from "../directForward"

const fullBody = Buffer.from("0123456789ABCDEF")

const chunked = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

const fetchFixture = (req: Request): Response => {
  const { pathname } = new URL(req.url)
  if (pathname === "/cookies") {
    const headers = new Headers({ "Content-Type": "text/html" })
    headers.append("Set-Cookie", "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/")
    headers.append("Set-Cookie", "clearance=two; Path=/; HttpOnly")
    return new Response("cookies", { headers })
  }
  if (pathname === "/cookie-video") {
    const headers = new Headers({ "Content-Type": "video/mp4" })
    headers.append("Set-Cookie", "session=one; Path=/")
    headers.append("Set-Cookie", "clearance=two; Path=/; Secure")
    return new Response(Buffer.from([0, 1, 2, 3]), { headers })
  }
  if (pathname === "/chunked-html")
    return new Response(
      chunked(Buffer.from("<!doctype html><title>Normal page</title>"), Buffer.from("<p>small response</p>")),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  if (pathname === "/chunked-challenge")
    return new Response(
      chunked(Buffer.from('<!doctype html><title>Just a moment...</title><div id="cf-browser-verification"></div>')),
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  if (pathname === "/gzip-challenge") {
    const body = gzipSync('<!doctype html><title>Just a moment...</title><div id="cf-browser-verification"></div>')
    return new Response(body, {
      status: 503,
      headers: { "Content-Encoding": "gzip", "Content-Type": "text/html; charset=utf-8" },
    })
  }
  if (pathname === "/akamai-challenge")
    return new Response('<html><div id="sec-if-cpt-container" class="behavioral-content"></div></html>', {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  if (pathname === "/video")
    return new Response(chunked(Buffer.from([0, 1, 2, 3]), Buffer.from([4, 5, 6, 7])), {
      headers: { "Content-Type": "video/mp4" },
    })
  if (pathname === "/fixed-video")
    return new Response(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), {
      headers: { "Content-Type": "video/mp4" },
    })

  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "")
  if (!match)
    return new Response(fullBody, {
      headers: { "Content-Type": "application/octet-stream" },
    })

  const start = Number(match[1])
  const end = Number(match[2])
  const body = fullBody.subarray(start, end + 1)
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${fullBody.length}`,
      "Content-Type": "application/octet-stream",
    },
  })
}

const createTestServer = () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 30_000 + ((process.pid + attempt * 997) % 20_000)
    try {
      return Bun.serve({ fetch: fetchFixture, hostname: "127.0.0.1", port })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("port")) throw error
    }
  }
  throw new Error("failed to bind direct-forward test server")
}

const server = createTestServer()
const baseUrl = `http://127.0.0.1:${server.port}`

afterAll(() => server.stop(true))

describe("directForwardHttp — Range / 206 Partial Content", () => {
  test("forwards Range request header and gets 206 Partial Content back", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: { Range: "bytes=4-9" },
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(206)
    expect(result.body.toString("latin1")).toBe("456789")
    expect(result.contentLength).toBe(6)
    expect(result.headers["content-range"]).toBe("bytes 4-9/16")
  })

  test("forwards multiple range types (single-byte suffix)", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: { Range: "bytes=15-15" },
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(206)
    expect(result.body.toString("latin1")).toBe("F")
    expect(result.contentLength).toBe(1)
    expect(result.headers["content-range"]).toBe("bytes 15-15/16")
  })

  test("no Range header → 200 + full body (Range pass-through, not injection)", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: {},
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(200)
    expect(result.body.length).toBe(fullBody.length)
    expect(result.body.toString("latin1")).toBe(fullBody.toString("latin1"))
    expect(result.headers["content-range"]).toBeUndefined()
  })

  test("preserves Content-Range through the proxy without re-computing", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/file.bin`,
      method: "GET",
      headers: { Range: "bytes=0-3" },
    })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.headers["content-range"]).toBe("bytes 0-3/16")
    expect(result.headers["content-length"]).toBe("4")
    expect(result.body.length).toBe(4)
  })
})

describe("directForwardHttp — buffered by default", () => {
  test("preserves repeated Set-Cookie fields using the internal newline convention", async () => {
    const result = await directForwardHttp({ url: `${baseUrl}/cookies`, method: "GET", headers: {} })
    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.headers["set-cookie"]).toBe(
      "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/\nclearance=two; Path=/; HttpOnly",
    )
  })

  test("preserves repeated Set-Cookie fields on streamed responses", async () => {
    const result = await directForwardHttp({ url: `${baseUrl}/cookie-video`, method: "GET", headers: {} })
    expect(result.mode).toBe("stream")
    if (result.mode !== "stream") return
    expect(result.headers["set-cookie"]).toBe("session=one; Path=/\nclearance=two; Path=/; Secure")
    result.socket.destroy()
  })

  test("skips 103 Early Hints and escalates cf-mitigated without waiting for an open body", async () => {
    const sockets = new Set<net.Socket>()
    const hangingServer = net.createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      socket.write(
        "HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\n" +
          "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nCF-Mitigated: Challenge\r\nConnection: keep-alive\r\n\r\n",
      )
    })
    hangingServer.listen(0, "127.0.0.1")
    await once(hangingServer, "listening")
    const address = hangingServer.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port")

    try {
      const startedAt = performance.now()
      const result = await directForwardHttp({
        url: `http://127.0.0.1:${address.port}/challenge`,
        method: "GET",
        headers: {},
        timeoutMs: 2_000,
      })

      expect(performance.now() - startedAt).toBeLessThan(500)
      expect(result.mode).toBe("buffer")
      if (result.mode !== "buffer") return
      expect(result.status).toBe(403)
      expect(result.challengeDetected).toBe(true)
      expect(result.headers["cf-mitigated"]).toBe("Challenge")
      expect(result.body.length).toBe(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => hangingServer.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("escalates a DataDome block from its header before waiting for an open body", async () => {
    const sockets = new Set<net.Socket>()
    const hangingServer = net.createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nX-DD-B: 1\r\nConnection: keep-alive\r\n\r\n")
    })
    hangingServer.listen(0, "127.0.0.1")
    await once(hangingServer, "listening")
    const address = hangingServer.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port")

    try {
      const startedAt = performance.now()
      const result = await directForwardHttp({
        url: `http://127.0.0.1:${address.port}/challenge`,
        method: "GET",
        headers: {},
        timeoutMs: 2_000,
      })
      expect(performance.now() - startedAt).toBeLessThan(500)
      expect(result.mode).toBe("buffer")
      if (result.mode !== "buffer") return
      expect(result.status).toBe(403)
      expect(result.challengeDetected).toBe(true)
      expect(result.body.length).toBe(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => hangingServer.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("escalates an AWS WAF Challenge header before waiting for an open body", async () => {
    const sockets = new Set<net.Socket>()
    const hangingServer = net.createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      socket.write(
        "HTTP/1.1 202 Accepted\r\nContent-Type: text/html\r\nX-AmZn-WaF-aCtIoN: Challenge\r\nConnection: keep-alive\r\n\r\n",
      )
    })
    hangingServer.listen(0, "127.0.0.1")
    await once(hangingServer, "listening")
    const address = hangingServer.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port")

    try {
      const startedAt = performance.now()
      const result = await directForwardHttp({
        url: `http://127.0.0.1:${address.port}/challenge`,
        method: "GET",
        headers: {},
        timeoutMs: 2_000,
      })
      expect(performance.now() - startedAt).toBeLessThan(500)
      expect(result.mode).toBe("buffer")
      if (result.mode !== "buffer") return
      expect(result.status).toBe(202)
      expect(result.challengeDetected).toBe(true)
      expect(result.body.length).toBe(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => hangingServer.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("buffers and de-chunks small HTML instead of treating it as a stream", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/chunked-html`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.body.toString()).toBe("<!doctype html><title>Normal page</title><p>small response</p>")
    expect(result.challengeDetected).toBe(false)
  })

  test("detects a challenge in a chunked HTML response", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/chunked-challenge`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.challengeDetected).toBe(true)
    expect(result.body.toString()).toContain("Just a moment")
  })

  test("detects a challenge in a compressed HTML response", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/gzip-challenge`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.challengeDetected).toBe(true)
    expect(result.headers["content-encoding"]).toBe("gzip")
  })

  test("detects a 200 Akamai behavioral interstitial", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/akamai-challenge`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("buffer")
    if (result.mode !== "buffer") return
    expect(result.status).toBe(200)
    expect(result.challengeDetected).toBe(true)
  })

  test("streams explicit video responses", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/video`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("stream")
    if (result.mode !== "stream") return
    result.socket.destroy()
  })

  test("streams video even when Content-Length is known", async () => {
    const result = await directForwardHttp({
      url: `${baseUrl}/fixed-video`,
      method: "GET",
      headers: {},
    })

    expect(result.mode).toBe("stream")
    if (result.mode !== "stream") return
    expect(result.contentLength).toBe(8)
    result.socket.destroy()
  })
})
