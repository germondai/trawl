import { readFileSync } from "node:fs"
import net from "node:net"
import tls from "node:tls"
import { isCloudflarePage, type OrchestratorDeps, scrape } from "@trawl/tiers"
import type { Cookie, SupportedMethod } from "@trawl/types"
import { MitmCa } from "./ca"

// Browser-backed MITM forward proxy.
//
// WHY THIS EXISTS: the FlareSolverr `/v1` contract only hands back cookies + user-agent.
// Clients like Prowlarr take those, then RE-FETCH the target with their own HTTP stack.
// Against sites whose Cloudflare clearance is bound to the solving browser's full
// connection fingerprint (not just cookie+UA), that re-fetch is re-challenged and fails —
// no cookie is portable to a plain HTTP client. See the FlareSolverr adapter for the
// legacy path.
//
// This proxy sidesteps that: point the client's HTTP(S) proxy at it (per-indexer in
// Prowlarr), and every request the client makes is transparently re-issued through the
// real browser pool via scrape(), so Cloudflare always sees the fingerprint it cleared.
//
// It is a MITM: it terminates the client's TLS using a per-host cert from our own CA
// (ca.ts). Only expose it to trusted clients on a private interface.

const MAX_HEADER_BYTES = 64 * 1024

export interface MitmProxyOptions {
  port: number
  caDir: string
  deps: OrchestratorDeps
  // Defaults to 127.0.0.1 in caller code so the proxy is unreachable from anything but
  // the local host (the per-host loopback TLS terminators stay on 127.0.0.1 unconditionally).
  host?: string
  maxTier?: 1 | 2 | 3 | 4
  maxTimeout?: number
  debug?: boolean
}

export function startMitmProxy(opts: MitmProxyOptions): {
  ca: MitmCa
  server: net.Server
} {
  const ca = new MitmCa(opts.caDir)

  // Per-host loopback TLS terminators. We know the target host from the CONNECT line, so
  // each host gets its own real listening TLS server whose base cert is that host's leaf —
  // no SNI routing needed (Bun's node:tls doesn't invoke SNICallback, and can't drive a
  // handshake via emit("connection"), so a real listening server per host is the reliable
  // path). On CONNECT we bridge the raw client socket to the matching server's loopback
  // port; it terminates TLS natively and hands us the decrypted stream.
  const tlsPorts = new Map<string, Promise<number>>()

  function tlsPortFor(host: string): Promise<number> {
    const existing = tlsPorts.get(host)
    if (existing) return existing
    const p = new Promise<number>((resolve, reject) => {
      const srv = tls.createServer({ key: ca.leafKeyPem, cert: ca.leafCertPem(host) }, (tlsSocket) => {
        tlsSocket.on("error", () => tlsSocket.destroy())
        serveRequests(tlsSocket, host, opts)
      })
      srv.on("error", reject)
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port))
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
        // Plain-HTTP proxy request: "GET http://host/path HTTP/1.1"
        // `first` arrives as Buffer from Bun's net.Socket 'data' event; the lib.dom.d.ts
        // type widens it to string|Buffer for cross-runtime compatibility, but we only
        // ever get bytes here.
        handlePlainHttp(clientSocket, first as Buffer, opts).catch(() => clientSocket.destroy())
      }
    })
    clientSocket.on("error", () => clientSocket.destroy())
  })

  server.on("error", (err) => console.error("[proxy] server error:", err instanceof Error ? err.message : err))
  // Bind to loopback by default — a MITM proxy trusts whoever installs its CA, so it must
  // never be exposed off-host unless the operator explicitly opts in via MITM_PROXY_HOST.
  // The per-host internal TLS terminators (above) stay on 127.0.0.1 unconditionally.
  server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
    console.log(`[proxy] MITM forward proxy on ${opts.host ?? "127.0.0.1"}:${opts.port}  (CA: ${ca.caCertPath})`)
  })

  return { ca, server }
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
    const body = contentLength > 0 ? buf.subarray(bodyStart, bodyStart + contentLength).toString("utf8") : undefined
    const url = `https://${headers.host ?? host}${path}`

    void reissue(stream, url, method as SupportedMethod, body, opts)
  }

  stream.on("data", onData)
}

async function reissue(
  stream: tls.TLSSocket,
  url: string,
  method: SupportedMethod,
  body: string | undefined,
  opts: MitmProxyOptions,
): Promise<void> {
  try {
    const res = await fetchRaw(url, method, body, opts)
    if (opts.debug) console.log(`[proxy] ${method} ${url} -> ${res.status} ${res.contentType} ${res.body.length}b`)
    writeResponse(stream, res.status || 200, res.body, res.contentType)
  } catch (err) {
    console.error("[proxy] reissue failed for", url, err instanceof Error ? err.message : err)
    writeResponse(stream, 502, Buffer.from(`TRAWL proxy error: ${err instanceof Error ? err.message : String(err)}`))
  }
}

// Re-issue the request through the browser pool and return the RAW response bytes
// (status + content-type + body). Raw bytes are essential: clients download .torrent
// files through this proxy, and rendering them as HTML (page.content()) corrupts the
// bencoded payload. Raw HTML is also what Cardigann-style parsers want.
//
// Fast path is a browser navigation reusing the domain's cached session (cf_clearance).
// If that comes back as a Cloudflare interstitial, we rotate the proxy the same way
// Tier 3 does (markBad → next()), retry with a fresh per-attempt context so the new
// proxy actually applies (the pool-shared context can't be reconfigured mid-flight),
// and only fall through to the full scrape() pipeline once proxy rotation is exhausted.
async function fetchRaw(
  url: string,
  method: SupportedMethod,
  body: string | undefined,
  opts: MitmProxyOptions,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  const domain = new URL(url).hostname
  const maxTimeout = opts.maxTimeout ?? 60_000
  const proxyPool = opts.deps.proxyPool

  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await opts.deps.acquireBrowser(domain)
    // Pick a fresh proxy per attempt — proxyPool.next() is sticky-per-domain until we
    // markBad(), at which point it rotates. No pool → no proxy, just reuse handle.context.
    const proxy = proxyPool?.next(domain) ?? undefined
    const createdFreshCtx = Boolean(proxy)
    const ctx = proxy
      ? await handle.browser.newContext({
          viewport: null,
          proxy: { server: proxy },
        })
      : handle.context
    const page = await ctx.newPage()
    try {
      const session = await opts.deps.loadSession(domain)
      if (session?.cookies?.length) {
        await ctx.addCookies(session.cookies.map(toPlaywrightCookie))
        await page.setExtraHTTPHeaders({ "User-Agent": session.userAgent })
      }
      if (method !== "GET" || body !== undefined) {
        await page.route(url, (route: { continue: (o: Record<string, unknown>) => void }) =>
          route.continue({
            method,
            ...(body !== undefined ? { postData: body } : {}),
          }),
        )
      }

      // A .torrent (application/x-bittorrent) makes Firefox start a DOWNLOAD instead of a
      // navigation, so page.goto aborts. Capture it via the download event and read the
      // saved file — this still uses the real browser network (correct fingerprint +
      // cf_clearance), just the file-download path instead of the document path.
      let download: PlaywrightDownload | undefined
      const downloadSeen = new Promise<void>((res) =>
        page.once("download", (d: PlaywrightDownload) => {
          download = d
          res()
        }),
      )

      let resp: PlaywrightResponse | null = null
      try {
        resp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: maxTimeout,
        })
      } catch (err) {
        // A download navigation rejects goto — wait briefly for the download event to land.
        await Promise.race([downloadSeen, sleep(3000)])
        if (!download) throw err
      }

      if (download) {
        const filePath = await download.path()
        const buf = filePath ? readFileSync(filePath) : Buffer.alloc(0)
        await download.delete().catch(() => {})
        return {
          status: 200,
          contentType: contentTypeFor(download.suggestedFilename()),
          body: buf,
        }
      }

      const status: number = resp?.status() ?? 0
      const respHeaders: Record<string, string> = resp?.headers() ?? {}
      const contentType = respHeaders["content-type"] ?? "application/octet-stream"
      const bodyBuf = Buffer.from((await resp?.body()) ?? new Uint8Array())

      // Challenge interstitials are always small HTML — only sniff those, never binaries.
      const looksHtml = /text\/html/i.test(contentType)
      const challenged =
        attempt === 0 &&
        (status === 403 || status === 503) &&
        looksHtml &&
        isCloudflarePage(bodyBuf.toString("utf8", 0, 4096), {})

      if (challenged) {
        // Same IP getting re-challenged means rotation has a real shot at clearing CF —
        // mirror Tier 3's markBad + next().
        if (proxy && proxyPool) proxyPool.markBad(proxy)
        // fall through to next attempt; finally still tears down the page and context
      } else {
        return { status, contentType, body: bodyBuf }
      }
    } finally {
      await page.close().catch(() => {})
      // Fresh per-attempt contexts must be closed explicitly or they leak.
      if (createdFreshCtx) await ctx.close().catch(() => {})
      opts.deps.releaseBrowser(handle.id)
    }
  }

  // Both raw attempts came back challenged — return whatever the solver produced as HTML.
  const solved = await scrape({ url, method, body, maxTier: opts.maxTier, maxTimeout }, opts.deps)
  return {
    status: solved.statusCode || 200,
    contentType: "text/html; charset=utf-8",
    body: Buffer.from(solved.html),
  }
}

// Minimal plain-HTTP (non-TLS) proxy support, mainly for completeness / http:// targets.
async function handlePlainHttp(clientSocket: net.Socket, first: Buffer, opts: MitmProxyOptions): Promise<void> {
  const headerText = first.toString("latin1")
  const line = headerText.split("\r\n", 1)[0] ?? ""
  const [method = "GET", absUrl = ""] = line.split(" ")
  if (!/^https?:\/\//.test(absUrl)) {
    clientSocket.destroy()
    return
  }
  try {
    const res = await fetchRaw(absUrl, method as SupportedMethod, undefined, opts)
    if (opts.debug)
      console.log(`[proxy] ${method} ${absUrl} (plain) -> ${res.status} ${res.contentType} ${res.body.length}b`)
    writeResponse(clientSocket, res.status || 200, res.body, res.contentType)
  } catch (err) {
    writeResponse(
      clientSocket,
      502,
      Buffer.from(`TRAWL proxy error: ${err instanceof Error ? err.message : String(err)}`),
    )
  }
}

// Minimal structural types for the Playwright objects we touch — camoufox-js doesn't
// re-export Playwright's types (see BrowserHandle in @trawl/types), so we shape just the
// members we call.
interface PlaywrightResponse {
  status(): number
  headers(): Record<string, string>
  body(): Promise<Buffer | Uint8Array>
}
interface PlaywrightDownload {
  path(): Promise<string | null>
  suggestedFilename(): string
  delete(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

// Best-effort content type from a downloaded filename — mainly so *arr clients see
// application/x-bittorrent for .torrent files.
function contentTypeFor(filename: string): string {
  if (/\.torrent$/i.test(filename)) return "application/x-bittorrent"
  if (/\.nzb$/i.test(filename)) return "application/x-nzb"
  return "application/octet-stream"
}

// Playwright's addCookies rejects unknown sameSite spellings — map/whitelist to its enum.
function toPlaywrightCookie(c: Cookie): Record<string, unknown> {
  const ss = (c.sameSite ?? "").toLowerCase()
  const sameSite = ss === "strict" ? "Strict" : ss === "lax" ? "Lax" : ss === "none" ? "None" : undefined
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    ...(sameSite ? { sameSite } : {}),
  }
}

function writeResponse(
  sock: net.Socket | tls.TLSSocket,
  status: number,
  body: Buffer,
  contentType = "text/html; charset=utf-8",
): void {
  const head =
    `HTTP/1.1 ${status} ${reason(status)}\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `Content-Length: ${body.length}\r\n` +
    "Connection: close\r\n\r\n"
  sock.write(head)
  sock.write(body)
  sock.end()
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
