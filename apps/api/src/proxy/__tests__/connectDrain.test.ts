import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import tls from "node:tls"
import { shutdownMitmProxy, startMitmProxy } from "../server"

test("CONNECT drains queued tunnel bytes after the upstream closes", async () => {
  const caDir = mkdtempSync(join(tmpdir(), "trawl-connect-drain-"))
  const payload = Buffer.alloc(32 * 1024, 123)
  const proxy = startMitmProxy({
    host: "127.0.0.1",
    port: 0,
    caDir,
    deps: {
      acquireBrowser: async () => {
        throw new Error("This test must not acquire a browser")
      },
      releaseBrowser() {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
    },
  })
  let delayedWrites = 0
  let writeTimer: ReturnType<typeof setTimeout> | undefined
  // Keep writes queued across upstream close without depending on OS TCP buffer sizes.
  proxy.server.on("connection", (socket) => {
    const write = socket._write.bind(socket)
    socket._writev = undefined
    let firstWrite = true
    socket._write = (chunk, encoding, callback) => {
      if (firstWrite) {
        firstWrite = false
        return write(chunk, encoding, callback)
      }
      delayedWrites++
      writeTimer = setTimeout(() => {
        if (socket.destroyed) callback(new Error("Client closed with queued bytes"))
        else write(chunk, encoding, callback)
      }, 50)
    }
  })
  // TLS records are opaque to the bridge; a TCP fixture isolates its close ordering.
  const terminator = spyOn(tls, "createServer").mockImplementation(
    () => net.createServer((socket) => socket.end(payload)) as tls.Server,
  )
  let raw: net.Socket | undefined
  try {
    if (!proxy.server.listening) await once(proxy.server, "listening")
    raw = net.connect((proxy.server.address() as net.AddressInfo).port, "127.0.0.1")
    raw.setTimeout(3000, () => raw?.destroy(new Error("CONNECT timed out")))
    const chunks: Buffer[] = []
    const complete = new Promise<void>((resolve, reject) => {
      raw?.once("close", resolve)
      raw?.on("error", reject)
      raw?.on("data", (chunk: Buffer) => chunks.push(chunk))
    })
    raw.write("CONNECT download.example:443 HTTP/1.1\r\nHost: download.example:443\r\n\r\n")
    await complete
    const received = Buffer.concat(chunks)
    const boundary = received.indexOf("\r\n\r\n")
    expect(delayedWrites).toBeGreaterThan(0)
    expect(boundary).toBeGreaterThan(0)
    expect(received.subarray(0, boundary).toString()).toContain("200 Connection Established")
    const body = received.subarray(boundary + 4)
    expect(body.length).toBe(payload.length)
    const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex")
    expect(digest(body)).toBe(digest(payload))
  } finally {
    clearTimeout(writeTimer)
    raw?.destroy()
    await shutdownMitmProxy(proxy, 100)
    terminator.mockRestore()
    rmSync(caDir, { recursive: true, force: true })
  }
}, 5000)
