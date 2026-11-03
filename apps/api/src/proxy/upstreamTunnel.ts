import http from "node:http"
import https from "node:https"
import net, { type Socket } from "node:net"

function readExactly(socket: Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, data?: Buffer) => {
      socket.off("readable", read)
      socket.off("error", fail)
      socket.off("end", ended)
      socket.off("close", ended)
      error ? reject(error) : resolve(data as Buffer)
    }
    const fail = (error: Error) => finish(error)
    const ended = () => finish(new Error("Proxy handshake ended early"))
    const read = () => {
      const data = socket.read(size) as Buffer | null
      if (data) data.length === size ? finish(undefined, data) : ended()
      else if (socket.destroyed || socket.readableEnded) ended()
    }
    socket.on("readable", read).once("error", fail).once("end", ended).once("close", ended)
    read()
  })
}

function tcp(host: string, port: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, signal })
    socket.on("error", () => {})
    socket.setTimeout(15_000, () => socket.destroy(new Error("Proxy connection timed out")))
    socket.once("error", reject).once("connect", () => {
      socket.off("error", reject)
      resolve(socket)
    })
  })
}

// The caller supplies a validated literal IP. The target hostname is never resolved by an upstream proxy.
export async function connectTunnel(
  address: string,
  port: number,
  upstream?: string,
  signal?: AbortSignal,
): Promise<Socket> {
  if (!net.isIP(address)) throw new Error("Tunnel destination must be an IP literal")
  if (!upstream) return tcp(address, port, signal)
  const proxy = new URL(upstream)
  if (proxy.protocol === "http:" || proxy.protocol === "https:") {
    return new Promise((resolve, reject) => {
      const authority = `${net.isIP(address) === 6 ? `[${address}]` : address}:${port}`
      const request = (proxy.protocol === "https:" ? https : http).request({
        hostname: proxy.hostname.replace(/^\[|\]$/g, ""),
        port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
        method: "CONNECT",
        path: authority,
        headers: {
          host: authority,
          ...(proxy.username || proxy.password
            ? {
                "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
              }
            : {}),
        },
        agent: false,
        signal,
      })
      const timer = setTimeout(() => request.destroy(new Error("Upstream proxy timed out")), 15_000)
      request.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      request.once("connect", (response, socket, head) => {
        clearTimeout(timer)
        socket.on("error", () => {})
        if (response.statusCode !== 200) {
          socket.destroy()
          reject(new Error(response.statusCode === 407 ? "Proxy authentication required" : "Proxy CONNECT refused"))
          return
        }
        if (head.length) socket.unshift(head)
        resolve(socket)
      })
      request.end()
    })
  }
  if (proxy.protocol !== "socks5:") throw new Error("Unsupported upstream proxy protocol")
  const socket = await tcp(proxy.hostname.replace(/^\[|\]$/g, ""), Number(proxy.port || 1080), signal)
  try {
    const username = Buffer.from(decodeURIComponent(proxy.username))
    const password = Buffer.from(decodeURIComponent(proxy.password))
    if (username.length > 255 || password.length > 255) throw new Error("SOCKS credentials exceed protocol limits")
    const authenticate = username.length > 0 || password.length > 0
    socket.write(Buffer.from(authenticate ? [5, 1, 2] : [5, 1, 0]))
    const method = await readExactly(socket, 2)
    if (method[0] !== 5 || method[1] !== (authenticate ? 2 : 0)) throw new Error("SOCKS authentication refused")
    if (authenticate) {
      socket.write(
        Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]),
      )
      const auth = await readExactly(socket, 2)
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error("SOCKS authentication refused")
    }
    let destination: Buffer
    if (net.isIP(address) === 4) destination = Buffer.from([1, ...address.split(".").map(Number)])
    else {
      const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
      const halves = canonical.split("::").map((half) => half.split(":").filter(Boolean))
      const words = [...halves[0], ...Array(8 - halves.flat().length).fill("0"), ...(halves[1] ?? [])]
      destination = Buffer.alloc(17)
      destination[0] = 4
      words.forEach((word, index) => {
        destination.writeUInt16BE(Number.parseInt(word, 16), 1 + index * 2)
      })
    }
    const targetPort = Buffer.alloc(2)
    targetPort.writeUInt16BE(port)
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), destination, targetPort]))
    const reply = await readExactly(socket, 4)
    if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error("SOCKS connection refused")
    const addressSize =
      reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readExactly(socket, 1))[0] : 0
    if (!addressSize) throw new Error("Invalid SOCKS reply")
    await readExactly(socket, addressSize + 2)
    socket.setTimeout(0)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}
