import { expect, test } from "bun:test"
import http from "node:http"
import net, { type Socket } from "node:net"
import { connectTunnel } from "./upstreamTunnel"

async function echo(socket: Socket): Promise<string> {
  const response = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("No echo"))
    }, 2000)
    socket.once("data", (data) => {
      clearTimeout(timer)
      resolve(data.toString())
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  socket.write("owned-echo")
  return response
}

test("upstream HTTP CONNECT receives only the literal IP and its own credentials", async () => {
  const server = http.createServer()
  let target = ""
  let auth: string | undefined
  const peers = new Set<Socket>()
  server.on("connect", (req, stream, head) => {
    const socket = stream as Socket
    peers.add(socket)
    socket.once("close", () => peers.delete(socket))
    target = req.url ?? ""
    auth = req.headers["proxy-authorization"]
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length) socket.write(head)
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No proxy port")
  try {
    const socket = await connectTunnel(
      "2001:4860:4860::8888",
      443,
      `http://operator:pass%40word@127.0.0.1:${address.port}`,
    )
    expect(await echo(socket)).toBe("owned-echo")
    expect(target).toBe("[2001:4860:4860::8888]:443")
    expect(auth).toBe(`Basic ${Buffer.from("operator:pass@word").toString("base64")}`)
    socket.destroy()
  } finally {
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("an upstream proxy denial is an error and never attempts a direct connection", async () => {
  const server = http.createServer()
  let attempts = 0
  server.on("connect", (_req, socket) => {
    attempts++
    socket.end("HTTP/1.1 407 Denied\r\nContent-Length: 0\r\n\r\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No proxy port")
  try {
    await expect(connectTunnel("1.1.1.1", 443, `http://127.0.0.1:${address.port}`)).rejects.toThrow("authentication")
    expect(attempts).toBe(1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test.each([false, true])(
  "SOCKS5 pins address bytes and handles fragmented replies with auth=%s",
  async (authenticate) => {
    const peers = new Set<Socket>()
    let destination: Buffer | undefined
    let credentials: string | undefined
    const server = net.createServer((socket) => {
      peers.add(socket)
      socket.once("close", () => peers.delete(socket))
      let buffer = Buffer.alloc(0)
      let phase = 0
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)])
        if (phase === 0 && buffer.length >= 3) {
          expect([...buffer.subarray(0, 3)]).toEqual(authenticate ? [5, 1, 2] : [5, 1, 0])
          buffer = buffer.subarray(3)
          phase = authenticate ? 1 : 2
          socket.write(Buffer.from([5]))
          setTimeout(() => socket.write(Buffer.from([authenticate ? 2 : 0])), 2)
        }
        if (phase === 1 && buffer.length >= 2) {
          const userLength = buffer[1]
          if (buffer.length < 3 + userLength) return
          const passwordLength = buffer[2 + userLength]
          if (buffer.length < 3 + userLength + passwordLength) return
          credentials = `${buffer.subarray(2, 2 + userLength)}:${buffer.subarray(3 + userLength, 3 + userLength + passwordLength)}`
          buffer = buffer.subarray(3 + userLength + passwordLength)
          phase = 2
          socket.write(Buffer.from([1, 0]))
        }
        if (phase === 2 && buffer.length >= (authenticate ? 22 : 10)) {
          destination = buffer
          buffer = Buffer.alloc(0)
          phase = 3
          socket.write(Buffer.from([5, 0, 0, 1]))
          setTimeout(() => socket.write(Buffer.from([127, 0, 0, 1, 0, 1])), 2)
        } else if (phase === 3 && buffer.length) {
          socket.write(buffer)
          buffer = Buffer.alloc(0)
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No proxy port")
    try {
      const socket = await connectTunnel(
        authenticate ? "2001:4860:4860::8888" : "1.1.1.1",
        443,
        `socks5://${authenticate ? "user:secret@" : ""}127.0.0.1:${address.port}`,
      )
      expect(await echo(socket)).toBe("owned-echo")
      expect(destination?.toString("hex")).toBe(
        authenticate ? "050100042001486048600000000000000000888801bb" : "050100010101010101bb",
      )
      expect(credentials).toBe(authenticate ? "user:secret" : undefined)
      socket.destroy()
    } finally {
      for (const peer of peers) peer.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)

test("SOCKS5 rejects a truncated handshake without leaving a tunnel", async () => {
  const server = net.createServer((socket) => socket.once("data", () => socket.end(Buffer.from([5]))))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No proxy port")
  try {
    await expect(connectTunnel("1.1.1.1", 443, `socks5://127.0.0.1:${address.port}`)).rejects.toThrow("ended early")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
