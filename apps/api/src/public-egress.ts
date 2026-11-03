import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { RequestValidationError } from "@trawl/tiers"
import { type HostLookup, parsePublicHttpUrl, resolvePublicHostname } from "./outbound-policy"
import { connectTunnel } from "./proxy/upstreamTunnel"

const MAX_CONNECTIONS = 128
const MAX_ROUTES = 512

interface Options {
  lookup?: HostLookup
  connect?: typeof connectTunnel
  validateUpstream?: (proxy: string) => Promise<void>
}

/** Local forwarding only: HTTPS stays end-to-end, and every connection uses an approved IP. */
export class PublicEgressProxy {
  private server?: Server
  private starting?: Promise<Server>
  private closing?: Promise<void>
  private readonly sockets = new Set<Socket>()
  private key = randomBytes(32)
  private readonly proxyUrls = new Map<string, string>()
  private pending = 0

  constructor(private readonly options: Options = {}) {}

  async proxyFor(upstream?: string): Promise<string> {
    if (this.closing) throw new RequestValidationError("Public egress proxy is closing", 503)
    if (upstream) await this.options.validateUpstream?.(upstream)
    if (Buffer.byteLength(upstream ?? "") > 4096) throw new RequestValidationError("Proxy URL is too long", 400)
    const existing = this.proxyUrls.get(upstream ?? "")
    if (existing) return existing
    const server = await this.start()
    if (this.closing || server !== this.server) throw new RequestValidationError("Public egress proxy is closing", 503)
    const cached = this.proxyUrls.get(upstream ?? "")
    if (cached) return cached
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Public proxy did not start")
    // Stateless authenticated tokens survive memo-cache eviction and hide upstream credentials.
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce)
    const encrypted = Buffer.concat([cipher.update(upstream ?? "", "utf8"), cipher.final()])
    const token = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")
    const url = `http://trawl:${token}@127.0.0.1:${address.port}`
    if (this.proxyUrls.size >= MAX_ROUTES) this.proxyUrls.delete(this.proxyUrls.keys().next().value ?? "")
    this.proxyUrls.set(upstream ?? "", url)
    return url
  }

  private start(): Promise<Server> {
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer({ maxHeaderSize: 16_384 }, (req, res) => {
        void this.forward(req, res).catch((error) => {
          if (res.headersSent) res.destroy()
          else
            res
              .writeHead(this.status(error), { "proxy-status": "trawl-public; error=destination_unavailable" })
              .end("Proxy request refused")
        })
      })
      server.maxConnections = MAX_CONNECTIONS
      server.headersTimeout = 10_000
      server.requestTimeout = 0
      server.keepAliveTimeout = 5_000
      server.on("connection", (socket) => {
        this.track(socket)
        socket.setTimeout(10_000, () => socket.destroy())
      })
      server.on("connect", (req, socket, head) => {
        const client = socket as Socket
        client.pause()
        void this.tunnel(req, client, head).catch((error) => this.refuse(client, this.status(error)))
      })
      server.on("upgrade", (req, socket, head) => {
        const client = socket as Socket
        client.pause()
        void this.upgrade(req, client, head).catch((error) => this.refuse(client, this.status(error)))
      })
      server.on("clientError", (_error, socket) => socket.destroy())
      server.once("error", (error) => {
        this.starting = undefined
        reject(error)
      })
      server.listen(0, "127.0.0.1", () => {
        this.server = server
        server.unref()
        resolve(server)
      })
    })
    return this.starting
  }

  private track(socket: Socket): void {
    this.sockets.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => this.sockets.delete(socket))
  }

  private route(req: IncomingMessage): { upstream?: string } {
    try {
      const header = req.headers["proxy-authorization"]
      if (typeof header !== "string" || !header.startsWith("Basic ")) throw new Error("Missing credentials")
      const credentials = Buffer.from(header.slice(6), "base64").toString()
      if (!credentials.startsWith("trawl:")) throw new Error("Invalid user")
      const token = Buffer.from(credentials.slice(6), "base64url")
      if (token.length < 28) throw new Error("Invalid token")
      const decipher = createDecipheriv("aes-256-gcm", this.key, token.subarray(0, 12))
      decipher.setAuthTag(token.subarray(12, 28))
      const upstream = Buffer.concat([decipher.update(token.subarray(28)), decipher.final()]).toString()
      return { upstream: upstream || undefined }
    } catch {
      throw new RequestValidationError("Proxy authentication required", 407)
    }
  }

  private status(error: unknown): number {
    return error instanceof RequestValidationError ? error.statusCode : 502
  }

  private refuse(socket: Socket, status: number): void {
    if (socket.destroyed) return
    socket.end(
      `HTTP/1.1 ${status} Proxy request refused\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="TRAWL"\r\n' : ""}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    )
  }

  private async dial(
    hostname: string,
    port: number,
    upstream: string | undefined,
    signal: AbortSignal,
  ): Promise<Socket> {
    if (this.pending >= MAX_CONNECTIONS) throw new RequestValidationError("Public proxy is busy", 503)
    this.pending++
    try {
      const addresses = await resolvePublicHostname(hostname, this.options.lookup)
      signal.throwIfAborted()
      if (upstream) await this.options.validateUpstream?.(upstream)
      signal.throwIfAborted()
      let failure: unknown
      for (const address of addresses.toSorted((a, b) => a.family - b.family)) {
        try {
          signal.throwIfAborted()
          const socket = await (this.options.connect ?? connectTunnel)(address.address, port, upstream, signal)
          if (signal.aborted) {
            socket.destroy()
            signal.throwIfAborted()
          }
          socket.setTimeout(0)
          this.track(socket)
          return socket
        } catch (error) {
          signal.throwIfAborted()
          failure = error
        }
      }
      throw failure ?? new Error("No public address could be reached")
    } finally {
      this.pending--
    }
  }

  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const { upstream } = this.route(req)
    if (!req.url || /[/?#@]/.test(req.url)) throw new RequestValidationError("Invalid CONNECT target", 400)
    const { url, hostname } = parsePublicHttpUrl(`https://${req.url}`)
    client.setTimeout(0)
    const abort = new AbortController()
    client.once("close", () => abort.abort())
    const peer = await this.dial(hostname, Number(url.port || 443), upstream, abort.signal)
    client.once("close", () => peer.destroy())
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length) peer.write(head)
    peer.once("close", () => client.destroy())
    client.pipe(peer).pipe(client)
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let upstream: string | undefined
    try {
      ;({ upstream } = this.route(req))
    } catch (error) {
      res.setHeader("proxy-authenticate", 'Basic realm="TRAWL"')
      throw error
    }
    const { url, hostname } = parsePublicHttpUrl(req.url ?? "")
    if (url.protocol !== "http:") throw new RequestValidationError("HTTPS requires CONNECT", 400)
    req.socket.setTimeout(0)
    const abort = new AbortController()
    res.once("close", () => abort.abort())
    const peer = await this.dial(hostname, Number(url.port || 80), upstream, abort.signal)
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host }
    delete headers["proxy-authorization"]
    delete headers["proxy-connection"]
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => peer
    const outbound = http.request(
      {
        hostname,
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        agent,
        signal: abort.signal,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      },
    )
    outbound.once("error", () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502).end("Proxy request failed")
    })
    res.once("close", () => {
      outbound.destroy()
      agent.destroy()
      peer.destroy()
    })
    req.pipe(outbound)
  }

  private async upgrade(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const { upstream } = this.route(req)
    const { url, hostname } = parsePublicHttpUrl((req.url ?? "").replace(/^ws:/i, "http:"))
    if (url.protocol !== "http:") throw new RequestValidationError("Invalid WebSocket target", 400)
    client.setTimeout(0)
    const abort = new AbortController()
    client.once("close", () => abort.abort())
    const peer = await this.dial(hostname, Number(url.port || 80), upstream, abort.signal)
    client.once("close", () => peer.destroy())
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host }
    delete headers["proxy-authorization"]
    delete headers["proxy-connection"]
    peer.write(
      `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n")}\r\n\r\n`,
    )
    if (head.length) peer.write(head)
    peer.once("close", () => client.destroy())
    client.pipe(peer).pipe(client)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      const server = await this.starting?.catch(() => undefined)
      for (const socket of this.sockets) socket.destroy()
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      this.server = undefined
      this.starting = undefined
      this.key = randomBytes(32)
      this.proxyUrls.clear()
    })().finally(() => {
      this.closing = undefined
    })
    return this.closing
  }
}
