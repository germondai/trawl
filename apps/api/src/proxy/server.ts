import net from "node:net"
import tls from "node:tls"
import {
  isValidMethod,
  type OrchestratorDeps,
  proxySanitizeHeaders,
  RESPONSE_HOP_BY_HOP_HEADERS,
  scrape,
} from "@trawl/tiers"
import { MitmCa } from "./ca"
import { ChallengeCache } from "./challengeCache"
import { directForwardHttp, directForwardHttps, type ForwardResult } from "./directForward"
import { responseFromScrapeResult } from "./responsePolicy"

// General forward proxy with browser-backed challenge escalation. HTTPS is
// MITM-terminated, so expose it only to clients that trust this instance's CA.

const MAX_HEADER_BYTES = 64 * 1024

const challengeCache = new ChallengeCache({ ttlMs: 5 * 60 * 1000 })

export interface MitmProxyOptions {
  port: number
  caDir: string
  deps: OrchestratorDeps
  host: string
  maxTier?: 1 | 2 | 3 | 4
  maxTimeout?: number
  debug?: boolean
}

export interface MitmProxyHandle {
  ca: MitmCa
  server: net.Server
  tlsServers: tls.Server[]
}

export function startMitmProxy(opts: MitmProxyOptions): MitmProxyHandle {
  const ca = new MitmCa(opts.caDir)

  // Per-host loopback TLS terminators. We know the target host from the CONNECT line, so
  // each host gets its own real listening TLS server whose base cert is that host's leaf —
  // no SNI routing needed (Bun's node:tls doesn't invoke SNICallback, and can't drive a
  // handshake via emit("connection"), so a real listening server per host is the reliable
  // path). On CONNECT we bridge the raw client socket to the matching server's loopback
  // port; it terminates TLS natively and hands us the decrypted stream.
  const tlsPorts = new Map<string, Promise<number>>()
  const tlsServers: tls.Server[] = []

  function tlsPortFor(host: string): Promise<number> {
    const existing = tlsPorts.get(host)
    if (existing) return existing
    const p = new Promise<number>((resolve, reject) => {
      const srv = tls.createServer({ key: ca.leafKeyPem, cert: ca.leafCertPem(host) }, (tlsSocket) => {
        tlsSocket.on("error", () => tlsSocket.destroy())
        serveRequests(tlsSocket, host, opts)
      })
      srv.on("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address()
        if (!address || typeof address === "string") {
          reject(new Error("TLS terminator did not bind to a TCP port"))
          return
        }
        tlsServers.push(srv)
        resolve(address.port)
      })
    })
    tlsPorts.set(host, p)
    return p
  }

  const server = net.createServer((clientSocket) => {
    clientSocket.once("data", (first) => {
      const firstLine = first.toString("latin1").split("\r\n", 1)[0] ?? ""
      const [method, target] = firstLine.split(" ")

      if (method === "CONNECT") {
        void handleConnect(clientSocket, target ?? "", tlsPortFor)
      } else {
        const initial = Buffer.isBuffer(first) ? first : Buffer.from(first)
        handlePlainHttp(clientSocket, initial, opts).catch(() => clientSocket.destroy())
      }
    })
    clientSocket.on("error", () => clientSocket.destroy())
  })

  server.on("error", (err) => console.error("[proxy] server error:", err instanceof Error ? err.message : err))
  server.listen(opts.port, opts.host, () => {
    console.log(`[proxy] MITM forward proxy on ${opts.host}:${opts.port}  (CA: ${ca.caCertPath})`)
  })

  return { ca, server, tlsServers }
}

// Graceful shutdown — stops accepting new connections and closes existing ones.
// Called from lifecycle.ts on SIGTERM/SIGINT before the browser pool shutdown.
export async function shutdownMitmProxy(handle: MitmProxyHandle, timeoutMs = 5_000): Promise<void> {
  const serverClosed = new Promise<void>((resolve) => {
    if (!handle.server.listening) {
      resolve()
      return
    }
    handle.server.close(() => resolve())
  })

  for (const srv of handle.tlsServers) {
    const closeAllConnections = (srv as tls.Server & { closeAllConnections?: () => void }).closeAllConnections
    closeAllConnections?.call(srv)
    srv.close()
  }

  await Promise.race([serverClosed, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}

// CONNECT host:port → 200, then bridge the raw client socket to the host's loopback TLS
// terminator. We pause first because reading the CONNECT line left the socket flowing —
// pipe() resumes it once the bridge is wired, so the client's ClientHello isn't dropped.
async function handleConnect(
  clientSocket: net.Socket,
  target: string,
  tlsPortFor: (host: string) => Promise<number>,
): Promise<void> {
  const host = target.split(":")[0] ?? ""
  if (!host) {
    clientSocket.destroy()
    return
  }
  clientSocket.pause()
  let port: number
  try {
    port = await tlsPortFor(host)
  } catch {
    clientSocket.destroy()
    return
  }
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
    const upstream = net.connect(port, "127.0.0.1", () => {
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.on("error", () => clientSocket.destroy())
    clientSocket.on("error", () => upstream.destroy())
  })
}

// Read one HTTP/1.1 request off the decrypted stream, re-issue it through the browser,
// and write the solved response back. We answer one request per TLS connection and close
// (Connection: close) — clients open a fresh CONNECT per request, which keeps parsing
// trivial and lets each request pick up the freshest cached session.
function serveRequests(stream: tls.TLSSocket, host: string, opts: MitmProxyOptions): void {
  const chunks: Buffer[] = []
  let total = 0

  const onData = (chunk: Buffer) => {
    chunks.push(chunk)
    total += chunk.length
    const buf = Buffer.concat(chunks)
    const headerEnd = buf.indexOf("\r\n\r\n")

    if (headerEnd === -1) {
      if (total > MAX_HEADER_BYTES) stream.destroy()
      return
    }

    const headerText = buf.subarray(0, headerEnd).toString("latin1")
    const lines = headerText.split("\r\n")
    const [method = "GET", path = "/"] = (lines[0] ?? "").split(" ")
    const headers = parseHeaders(lines.slice(1))

    const contentLength = Number(headers["content-length"] ?? "0")
    const bodyStart = headerEnd + 4
    const bodyAvailable = buf.length - bodyStart
    if (contentLength > 0 && bodyAvailable < contentLength) return // wait for full body

    stream.off("data", onData)
    // Raw body bytes — UTF-8 decoding would corrupt binary uploads (PDFs, .torrent
    // POSTs, etc.). proxyRequest() forwards them as Buffer.
    const body = contentLength > 0 ? buf.subarray(bodyStart, bodyStart + contentLength) : undefined
    const url = `https://${headers.host ?? host}${path}`

    // WebSocket upgrade: skip HTTP framing entirely, relay raw bytes between client
    // and upstream after the 101 Switching Protocols handshake. CF bypass doesn't
    // apply (most WS servers aren't behind CF; if they are, client retries through
    // browser which handles WS in-page).
    const upgradeValue = (headers.upgrade ?? "").toLowerCase()
    if (upgradeValue.includes("websocket")) {
      const target = new URL(`https://${headers.host ?? host}`)
      void proxyWebSocket(stream, method, path, headers, target.hostname, target.port ? Number(target.port) : 443, true)
      return
    }

    void proxyRequest(stream, url, method, headers, body, opts)
  }

  stream.on("data", onData)
}

// WebSocket relay for HTTPS-tunneled traffic (CONNECT → MITM-terminated).
// Re-encrypts bytes via a fresh TLS connection to upstream; once the 101
// Switching Protocols handshake completes, both sockets are raw-byte-piped
// in both directions. Connection: close is handled by client disconnect or
// upstream EOF.
async function proxyWebSocket(
  clientSocket: net.Socket,
  method: string,
  path: string,
  headers: Record<string, string>,
  host: string,
  port: number,
  isHttps: boolean,
): Promise<void> {
  const upstream = isHttps
    ? tls.connect({ host, port, servername: host, minVersion: "TLSv1.2" })
    : net.createConnection({ host, port })

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      try {
        clientSocket.destroy()
      } catch {}
      try {
        upstream.destroy()
      } catch {}
    }

    upstream.once("error", () => {
      cleanup()
      resolve()
    })
    clientSocket.once("error", () => {
      cleanup()
      resolve()
    })

    upstream.once(isHttps ? "secureConnect" : "connect", () => {
      // Forward the Upgrade request verbatim, minus hop-by-hop headers.
      const requestLines = [`${method} ${path} HTTP/1.1`]
      for (const [k, v] of Object.entries(headers)) {
        const lower = k.toLowerCase()
        if (RESPONSE_HOP_BY_HOP_HEADERS.has(lower)) continue
        requestLines.push(`${k}: ${v}`)
      }
      requestLines.push("Connection: Upgrade", `Upgrade: ${headers.upgrade ?? "websocket"}`)
      upstream.write(`${requestLines.join("\r\n")}\r\n\r\n`)

      // Read until end of HTTP response headers (\r\n\r\n). For 101 Switching
      // Protocols there is no body — once we see the blank line, both sides
      // speak raw WebSocket frames.
      const chunks: Buffer[] = []
      let totalBytes = 0
      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        totalBytes += chunk.length
        const combined = Buffer.concat(chunks, totalBytes)
        const headerEnd = combined.indexOf("\r\n\r\n")
        if (headerEnd < 0) {
          if (totalBytes > 64 * 1024) {
            upstream.off("data", onData)
            cleanup()
            resolve()
          }
          return
        }
        upstream.off("data", onData)
        // Forward the entire response (including any bytes past the header
        // terminator — rare for 101 but defensive).
        clientSocket.write(combined.subarray(0, headerEnd + 4))
        if (headerEnd + 4 < combined.length) {
          clientSocket.write(combined.subarray(headerEnd + 4))
        }
        // Both sides now speak raw WebSocket frames — bidirectional byte pipe.
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
        resolve()
      }
      upstream.on("data", onData)
    })

    upstream.once("close", () => {
      try {
        clientSocket.destroy()
      } catch {}
      resolve()
    })
    clientSocket.once("close", () => {
      try {
        upstream.destroy()
      } catch {}
      resolve()
    })
  })
}

// New request entry point used by serveRequests. Tier 0 = direct TCP/TLS forward
// to upstream with challenge detection. On challenge, escalate to the existing
// tier pipeline (`scrape()` from @trawl/tiers — Tier 1 plain HTTP, Tier 2 cached
// browser session, Tier 3 fresh CF solve, Tier 4 residential).
//
async function proxyRequest(
  stream: net.Socket,
  url: string,
  method: string,
  clientHeaders: Record<string, string>,
  body: Buffer | undefined,
  opts: MitmProxyOptions,
): Promise<void> {
  let domain: string
  try {
    domain = new URL(url).hostname
  } catch {
    writeResponse(stream, 400, Buffer.from("bad URL"))
    return
  }

  // Trust the cache for repeat visits — skip Tier 0 entirely if we recently saw
  // a CF challenge here and jump straight to scrape().
  const cachedMode = challengeCache.get(domain)
  if (cachedMode === "cf") {
    return await serveViaScrape(stream, url, method, clientHeaders, body, opts)
  }

  // Tier 0 performs a normal direct request. Small responses are buffered so
  // challenge detection sees the complete HTML; only explicit video/large-file
  // responses are returned as streams by directForward.
  const sanitized = proxySanitizeHeaders(clientHeaders) ?? {}
  const useHttps = url.startsWith("https://")
  let tier0: ForwardResult
  try {
    if (useHttps) {
      const parsed = new URL(url)
      tier0 = await directForwardHttps({
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: sanitized,
        body,
        skipChallengeDetection: false,
      })
    } else {
      tier0 = await directForwardHttp({
        url,
        method,
        headers: sanitized,
        body,
        skipChallengeDetection: false,
      })
    }
  } catch (err) {
    tier0 = { mode: "error", error: err instanceof Error ? err : new Error(String(err)) }
  }

  if (tier0.mode === "error") {
    if (opts.debug) console.log(`[proxy] Tier 0 error for ${url}: ${tier0.error.message}`)
    return await serveViaScrape(stream, url, method, clientHeaders, body, opts)
  }

  if (tier0.mode === "stream") {
    if (opts.debug) console.log(`[proxy] Tier 0 stream for ${url} -> ${tier0.status}`)
    challengeCache.set(domain, "direct")
    writeResponseFromStream(
      stream,
      tier0.status,
      tier0.headers,
      tier0.socket,
      tier0.contentType,
      body?.length ?? 0,
      tier0.prefix,
    )
    return
  }

  if (tier0.challengeDetected) {
    if (opts.debug) console.log(`[proxy] Tier 0 challenge for ${url} -> escalating to scrape()`)
    challengeCache.set(domain, "cf")
    return await serveViaScrape(stream, url, method, clientHeaders, body, opts)
  }

  challengeCache.set(domain, "direct")
  writeResponseFromBuffer(stream, tier0.status, tier0.headers, tier0.body, tier0.contentType)
}

// Tier 1+ fallback: reissue through the existing browser-backed scrape pipeline.
// Used when Tier 0 detects a challenge, encounters a network error, or sees the
// domain in challengeCache as "cf".
async function serveViaScrape(
  stream: net.Socket,
  url: string,
  method: string,
  clientHeaders: Record<string, string>,
  body: Buffer | undefined,
  opts: MitmProxyOptions,
): Promise<void> {
  try {
    if (!isValidMethod(method)) {
      writeResponse(stream, 400, Buffer.from(`unsupported method: ${method}`), "text/plain; charset=utf-8")
      return
    }
    const scrapeResult = await scrape(
      {
        url,
        method,
        headers: proxySanitizeHeaders(clientHeaders) ?? undefined,
        body: body?.toString("utf8"),
        maxTier: opts.maxTier,
        maxTimeout: opts.maxTimeout,
      },
      opts.deps,
    )
    if (opts.debug)
      console.log(
        `[proxy] scrape() tier ${scrapeResult.tier} for ${url} -> ${scrapeResult.statusCode} html=${scrapeResult.html?.length ?? 0}b body=${scrapeResult.body?.length ?? 0}b`,
      )

    if (opts.debug) {
      for (const t of scrapeResult.timings) {
        console.log(`  tier ${t.tier}: ${t.status} (${t.durationMs}ms) ${t.reason ?? ""}`)
      }
    }

    // Browser tiers expose both the original navigation response and the
    // rendered DOM. For HTML, the latter is the solved page behind the challenge.
    // Binary responses retain their exact raw bytes.
    const response = responseFromScrapeResult(scrapeResult)
    if (opts.debug) {
      console.log(
        `[proxy] writeResponseFromBuffer status=${scrapeResult.statusCode || 200} payload=${response.body.length}b contentType=${response.contentType}`,
      )
    }
    writeResponseFromBuffer(
      stream,
      scrapeResult.statusCode || 200,
      response.headers,
      response.body,
      response.contentType,
    )
  } catch (err) {
    console.error("[proxy] scrape() failed for", url, err instanceof Error ? err.message : err)
    writeResponseFromBuffer(
      stream,
      502,
      { "Content-Type": "text/plain; charset=utf-8" },
      Buffer.from(`TRAWL proxy error: ${err instanceof Error ? err.message : String(err)}`),
      "text/plain; charset=utf-8",
    )
  }
}

// Minimal plain-HTTP (non-TLS) proxy support, mainly for completeness / http:// targets.
async function handlePlainHttp(clientSocket: net.Socket, first: Buffer, opts: MitmProxyOptions): Promise<void> {
  // Accumulate full HTTP headers before dispatching — needed to detect Upgrade: websocket
  // and to know where the body starts. The first chunk from the main listener is already
  // a complete request in most cases (curl/Chromium send headers + small body in one packet),
  // so check the boundary inline before waiting for another 'data' event.
  const chunks: Buffer[] = [first]
  let total = first.length
  let onData: ((chunk: Buffer) => void) | undefined

  const tryDispatch = (): boolean => {
    const buf = Buffer.concat(chunks, total)
    const headerEnd = buf.indexOf("\r\n\r\n")
    if (headerEnd < 0) {
      if (total > MAX_HEADER_BYTES) {
        clientSocket.destroy()
        return true
      }
      return false
    }

    const headerText = buf.subarray(0, headerEnd).toString("latin1")
    const lines = headerText.split("\r\n")
    const [method = "GET", absUrl = ""] = (lines[0] ?? "").split(" ")
    const headers = parseHeaders(lines.slice(1))

    // WebSocket upgrade on plain HTTP (ws://): relay raw bytes between client
    // and upstream after the 101 Switching Protocols handshake.
    const upgradeValue = (headers.upgrade ?? "").toLowerCase()
    if (upgradeValue.includes("websocket")) {
      try {
        const parsed = new URL(absUrl)
        const isHttps = parsed.protocol === "wss:"
        proxyWebSocket(
          clientSocket,
          method,
          `${parsed.pathname}${parsed.search}`,
          headers,
          parsed.hostname,
          parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
          isHttps,
        ).catch(() => {})
      } catch {
        clientSocket.destroy()
      }
      return true
    }

    if (!/^https?:\/\//.test(absUrl)) {
      clientSocket.destroy()
      return true
    }

    const contentLength = Number(headers["content-length"] ?? "0")
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      writeResponseFromBuffer(
        clientSocket,
        400,
        { "content-type": "text/plain; charset=utf-8" },
        Buffer.from("invalid Content-Length"),
        "text/plain; charset=utf-8",
      )
      return true
    }
    if (buf.length < headerEnd + 4 + contentLength) return false
    if (onData) clientSocket.off("data", onData)

    const body = contentLength > 0 ? buf.subarray(headerEnd + 4, headerEnd + 4 + contentLength) : undefined
    void proxyRequest(clientSocket, absUrl, method, headers, body, opts)
    return true
  }

  if (tryDispatch()) return

  await new Promise<void>((resolve) => {
    onData = (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (tryDispatch()) resolve()
    }
    clientSocket.on("data", onData)
    clientSocket.once("error", () => {
      clientSocket.destroy()
      resolve()
    })
  })
}

function writeResponse(sock: net.Socket, status: number, body: Buffer, contentType = "text/html; charset=utf-8"): void {
  const head =
    `HTTP/1.1 ${status} ${reason(status)}\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `Content-Length: ${body.length}\r\n` +
    "Connection: close\r\n\r\n"
  sock.write(head)
  sock.write(body)
  sock.end()
}

// Buffered responses preserve end-to-end headers and derive a fresh body length.
// Exported for unit tests only — not part of the public proxy API.
export function writeResponseFromBuffer(
  sock: net.Socket,
  status: number,
  upstreamHeaders: Record<string, string>,
  body: Buffer,
  fallbackContentType: string,
): void {
  const ct = upstreamHeaders["content-type"] ?? fallbackContentType
  const headerLines: string[] = [`HTTP/1.1 ${status} ${reason(status)}`]
  let emittedContentType = false
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    if (RESPONSE_HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === "content-length") continue
    if (lower === "content-type") emittedContentType = true
    // Playwright joins multiple Set-Cookie values with \n into one map entry.
    // Emit each cookie as its own header line — RFC 6265 forbids comma-folding.
    if (lower === "set-cookie") {
      for (const cookie of value.split("\n")) {
        if (cookie.trim()) headerLines.push(`${name}: ${cookie.trim()}`)
      }
      continue
    }
    headerLines.push(`${name}: ${value}`)
  }
  if (!emittedContentType) headerLines.push(`Content-Type: ${ct}`)
  headerLines.push(`Content-Length: ${body.length}`)
  headerLines.push("Connection: close")
  sock.write(`${headerLines.join("\r\n")}\r\n\r\n`)
  sock.write(body)
  sock.end()
}

// Streamed responses retain upstream transfer framing.
function writeResponseFromStream(
  sock: net.Socket,
  status: number,
  upstreamHeaders: Record<string, string>,
  upstreamSocket: net.Socket,
  fallbackContentType: string,
  requestBodyLength: number,
  prefix?: Buffer,
): void {
  const headerLines: string[] = [`HTTP/1.1 ${status} ${reason(status)}`]
  let emittedContentType = false
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    // The streamed bytes retain upstream HTTP/1.1 chunk framing, so preserve
    // Transfer-Encoding. Other hop-by-hop headers remain connection-local.
    if (RESPONSE_HOP_BY_HOP_HEADERS.has(lower) && lower !== "transfer-encoding") continue
    if (lower === "content-type") emittedContentType = true
    headerLines.push(`${name}: ${value}`)
  }
  if (!emittedContentType) headerLines.push(`Content-Type: ${fallbackContentType}`)
  if (requestBodyLength > 0) headerLines.push(`X-Forwarded-Body-Length: ${requestBodyLength}`)
  headerLines.push("Connection: close")
  // Write HTTP headers first, then prefix body bytes (which arrived in the same
  // TCP segment as upstream's response headers), then pipe the rest of the body.
  sock.write(`${headerLines.join("\r\n")}\r\n\r\n`)
  if (prefix?.length) sock.write(prefix)
  upstreamSocket.pipe(sock)
  sock.on("error", () => upstreamSocket.destroy())
  upstreamSocket.on("error", () => sock.destroy())
  upstreamSocket.on("end", () => sock.end())
  upstreamSocket.on("close", () => sock.end())
}

function parseHeaders(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of lines) {
    const idx = line.indexOf(":")
    if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  return out
}

function reason(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    403: "Forbidden",
    404: "Not Found",
    500: "Internal Server Error",
    502: "Bad Gateway",
  }
  return map[status] ?? "OK"
}
