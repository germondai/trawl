import { describe, expect, test } from "bun:test"
import { once } from "node:events"
import http from "node:http"
import net from "node:net"
import { PassThrough } from "node:stream"
import { serializeResponseHeaders, writeResponseFromStream } from "../httpResponse"

describe("proxy response serialization", () => {
  test.each([
    { method: "HEAD", status: 200, preservesLength: true },
    { method: "GET", status: 204, preservesLength: false },
    { method: "GET", status: 304, preservesLength: true },
  ])("preserves bodyless metadata for $method $status", ({ method, status, preservesLength }) => {
    const head = serializeResponseHeaders(
      status,
      { "content-length": "12", "transfer-encoding": "chunked" },
      "text/plain",
      { bodyLength: 0, method },
    )
    expect(head.includes("content-length: 12")).toBe(preservesLength)
    expect(head).not.toContain("Content-Length: 0")
    expect(head).not.toContain("transfer-encoding")
  })

  test("destroys the upstream stream when the client closes without an error", async () => {
    const client = new PassThrough()
    const upstream = new PassThrough()
    client.resume()
    writeResponseFromStream(client as unknown as net.Socket, 200, {}, upstream as unknown as net.Socket, "video/mp4", 0)
    client.destroy()
    await Bun.sleep(0)
    expect(upstream.destroyed).toBe(true)
    upstream.destroy()
  })

  test.each([false, true])("emits each cookie as a valid field for streamed=%s", (streamed) => {
    const head = serializeResponseHeaders(
      200,
      {
        "content-type": "text/html",
        "set-cookie": "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/\n \nclearance=two; Path=/; HttpOnly",
      },
      "application/octet-stream",
      streamed ? { streamed: true } : { bodyLength: 0 },
    )
    const lines = head.split("\r\n")
    expect(lines.filter((line) => line.toLowerCase().startsWith("set-cookie:"))).toEqual([
      "set-cookie: session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
      "set-cookie: clearance=two; Path=/; HttpOnly",
    ])
    expect(lines).not.toContain("clearance=two; Path=/; HttpOnly")
  })

  test("leaves a single cookie unchanged", () => {
    const head = serializeResponseHeaders(200, { "set-cookie": "session=one; Path=/" }, "text/plain", {
      bodyLength: 0,
    })
    expect(head.match(/set-cookie:/gi)).toHaveLength(1)
    expect(head).toContain("set-cookie: session=one; Path=/\r\n")
  })

  test("is accepted by a strict HTTP parser as two separate cookie fields", async () => {
    const body = Buffer.from("ok")
    const head = serializeResponseHeaders(
      200,
      {
        "content-type": "text/plain",
        "set-cookie": "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/\r\nclearance=two; Path=/; Secure",
      },
      "text/plain",
      { bodyLength: body.length },
    )
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.end(Buffer.concat([Buffer.from(head), body])))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")

    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: address.port, path: "/" }, resolve).once("error", reject)
      })
      response.resume()
      await once(response, "end")
      expect(response.headers["set-cookie"]).toEqual([
        "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
        "clearance=two; Path=/; Secure",
      ])
      expect(response.rawHeaders.filter((header) => header.toLowerCase() === "set-cookie")).toHaveLength(2)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
