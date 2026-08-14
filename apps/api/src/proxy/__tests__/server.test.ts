import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type net from "node:net"
import { writeResponseFromBuffer } from "../server"

describe("writeResponseFromBuffer — Set-Cookie newline folding", () => {
  test("emits one Set-Cookie line per cookie when Playwright newline-folds them", () => {
    // Playwright's response.allHeaders() joins multiple Set-Cookie values with \n.
    // A bare value after the fold creates a 'malformed MIME header line' error in
    // strict HTTP/1.1 clients (e.g. Go's net/http) when the Expires date contains
    // a comma.
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    const cookieA = "session-id=abc; Domain=.example.com; Path=/; Secure"
    const cookieB =
      "session-id-time=123456789l; Domain=.example.com; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Path=/; Secure"

    writeResponseFromBuffer(
      stream as unknown as net.Socket,
      200,
      { "set-cookie": `${cookieA}\n${cookieB}`, "content-type": "text/html" },
      Buffer.from("ok"),
      "text/html",
    )

    const raw = Buffer.concat(chunks).toString("latin1")
    const lines = raw.split("\r\n")
    const cookieLines = lines.filter((l) => l.toLowerCase().startsWith("set-cookie:"))

    // Must produce two separate header lines, not one line with an embedded newline.
    expect(cookieLines).toHaveLength(2)
    expect(cookieLines[0]).toContain("session-id=abc")
    expect(cookieLines[1]).toContain("session-id-time=")

    // No bare continuation line — the Expires comma must not produce a split.
    const malformed = lines.filter((l) => /^session-id-time=/.test(l))
    expect(malformed).toHaveLength(0)
  })

  test("passes through a single-value Set-Cookie header unchanged", () => {
    const stream = new PassThrough()
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))

    writeResponseFromBuffer(
      stream as unknown as net.Socket,
      200,
      { "set-cookie": "token=xyz; Path=/; HttpOnly", "content-type": "text/html" },
      Buffer.from("ok"),
      "text/html",
    )

    const raw = Buffer.concat(chunks).toString("latin1")
    const lines = raw.split("\r\n")
    const cookieLines = lines.filter((l) => l.toLowerCase().startsWith("set-cookie:"))
    expect(cookieLines).toHaveLength(1)
    expect(cookieLines[0]).toContain("token=xyz")
  })
})
