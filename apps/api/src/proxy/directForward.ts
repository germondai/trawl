// Tier 0 — direct TCP/TLS forward to upstream.
//
// Why: the MITM proxy at :8192 used to spin up a browser for every single
// request, including Netflix/YouTube/banks that don't need CF bypass. Tier 0
// makes those requests near-direct: open a socket to upstream, write the
// client's request, read the response. If the response looks like a challenge,
// escalate to the existing browser-tier pipeline (`scrape()` from @trawl/tiers).
//
// Two entry points:
//   - directForwardHttp()  → plain HTTP (no client TLS)
//   - directForwardHttps() → upstream is HTTPS (open new TLS socket to upstream)
//
// Both return a `ForwardResult` telling the caller whether to buffer (small
// response, do challenge detection) or stream (large/binary response, pipe
// through to the client untouched).

import net from "node:net"
import tls from "node:tls"
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib"
import { detectChallengeType, isChallengeWall } from "@trawl/tiers"
import { shouldStream } from "./streaming"

export interface ForwardResultBuffered {
  mode: "buffer"
  status: number
  headers: Record<string, string>
  contentType: string
  contentLength?: number
  body: Buffer
  challengeDetected: boolean
}

export interface ForwardResultStream {
  mode: "stream"
  status: number
  headers: Record<string, string>
  contentType: string
  contentLength?: number
  // The live upstream socket. The caller must pipe this to the client socket
  // and close it when the upstream ends.
  socket: net.Socket
  // Body bytes the caller should write to the client BEFORE piping the socket —
  // these arrived in the same TCP segment as the response headers, so the upstream
  // socket hasn't seen them yet. Writing them first preserves byte ordering.
  prefix?: Buffer
}

export interface ForwardResultError {
  mode: "error"
  error: Error
}

export type ForwardResult = ForwardResultBuffered | ForwardResultStream | ForwardResultError

const MAX_HEADER_BYTES = 64 * 1024

export interface DirectForwardHttpOpts {
  url: string
  method: string
  headers: Record<string, string>
  body?: Buffer
  // If true, do NOT challenge-detect the response — just buffer and return.
  // Used by the caller when challengeCache already says this hostname is "cf".
  skipChallengeDetection?: boolean
  // Socket timeout for the upstream connection. Default 30s.
  timeoutMs?: number
}

export async function directForwardHttp(opts: DirectForwardHttpOpts): Promise<ForwardResult> {
  const parsed = new URL(opts.url)
  if (parsed.protocol !== "http:") {
    return { mode: "error", error: new Error(`directForwardHttp: expected http://, got ${parsed.protocol}`) }
  }
  const port = parsed.port ? Number(parsed.port) : 80
  const host = parsed.hostname

  // Construct an unconnected socket; the callback below performs the single
  // connect attempt. Calling connect() on a socket returned by
  // createConnection() races two connection attempts under Bun.
  const socket = new net.Socket()
  // Bun panics on socket.write() if no handlers are attached ("No handlers set
  // on Socket"). Attach an error handler immediately so writes are safe; the
  // real error handling is set up after socket.connect.
  socket.on("error", () => {})
  return new Promise<ForwardResult>((resolve) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ mode: "error", error: err })
    }

    const timeout = opts.timeoutMs ?? 30_000
    socket.setTimeout(timeout)
    socket.once("timeout", () => fail(new Error(`upstream timeout after ${timeout}ms`)))
    socket.once("error", fail)

    socket.connect(port, host, () => {
      const authority = parsed.port ? `${host}:${parsed.port}` : host
      const path = `${parsed.pathname}${parsed.search}`
      writeRequest(socket, requestHead(opts.method, path, authority, opts.headers, opts.body), opts.body)

      readHttpResponse(socket, opts.url, opts.skipChallengeDetection ?? false)
        .then((result) => {
          if (settled) return
          settled = true
          resolve(result)
        })
        .catch(fail)
    })
  })
}

export interface DirectForwardHttpsOpts {
  host: string
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: Buffer
  skipChallengeDetection?: boolean
  timeoutMs?: number
  servername?: string
}

const requestHead = (
  method: string,
  path: string,
  host: string,
  headers: Record<string, string>,
  body?: Buffer,
): string => {
  const forwarded: Record<string, string> = { Host: host, ...headers }
  delete forwarded.host
  if (body?.length && forwarded["content-length"] === undefined) forwarded["Content-Length"] = String(body.length)

  return `${method} ${path} HTTP/1.1\r\n${Object.entries(forwarded)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n")}\r\n\r\n`
}

const writeRequest = (socket: net.Socket, head: string, body?: Buffer): void => {
  socket.write(head)
  if (body?.length) socket.write(body)
}

export async function directForwardHttps(opts: DirectForwardHttpsOpts): Promise<ForwardResult> {
  const socket = tls.connect({
    host: opts.host,
    port: opts.port,
    servername: opts.servername ?? opts.host,
    minVersion: "TLSv1.2",
  })
  // Same Bun-safety as directForwardHttp: attach a no-op error handler so
  // subsequent socket.write() calls don't panic before readUpTo attaches the
  // real handlers.
  socket.on("error", () => {})
  return new Promise<ForwardResult>((resolve) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ mode: "error", error: err })
    }

    const timeout = opts.timeoutMs ?? 30_000
    socket.setTimeout(timeout)
    socket.once("timeout", () => fail(new Error(`upstream TLS timeout after ${timeout}ms`)))
    socket.once("error", fail)

    socket.once("secureConnect", () => {
      const host = opts.port === 443 ? opts.host : `${opts.host}:${opts.port}`
      writeRequest(socket, requestHead(opts.method, opts.path, host, opts.headers, opts.body), opts.body)

      readHttpResponse(socket, `https://${opts.host}${opts.path}`, opts.skipChallengeDetection ?? false)
        .then((result) => {
          if (settled) return
          settled = true
          resolve(result)
        })
        .catch(fail)
    })
  })
}

// Read HTTP/1.1 response off the socket. Splits into header + body. Returns
// either a buffered result (with challenge detection done) or a stream result
// (caller takes over the socket for piping).
async function readHttpResponse(
  socket: net.Socket,
  url: string,
  skipChallengeDetection: boolean,
  initialResponseBytes: Buffer = Buffer.alloc(0),
): Promise<ForwardResult> {
  const headerBuf = await readUpTo(socket, MAX_HEADER_BYTES, "\r\n\r\n", initialResponseBytes)
  if (!headerBuf.found) {
    socket.destroy()
    return { mode: "error", error: new Error("upstream response headers exceeded 64 KiB") }
  }

  const headerText = headerBuf.text
  const lines = headerText.split("\r\n")
  const statusLine = lines[0] ?? ""
  const statusMatch = statusLine.match(/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/i)
  if (!statusMatch) {
    socket.destroy()
    return { mode: "error", error: new Error(`upstream returned non-HTTP status line: ${statusLine}`) }
  }
  const status = Number(statusMatch[1])

  // Informational responses (most commonly Cloudflare's 103 Early Hints) are
  // followed by another HTTP response on the same connection. Do not treat the
  // final response headers/body as the body of the 1xx response.
  if (status >= 100 && status < 200 && status !== 101) {
    return readHttpResponse(socket, url, skipChallengeDetection, headerBuf.leftover)
  }

  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (!name) continue
    if (name === "set-cookie" && headers[name] !== undefined) {
      headers[name] += `\n${value}`
    } else if (headers[name] === undefined) {
      headers[name] = value
    }
  }

  const contentType = headers["content-type"] ?? "application/octet-stream"
  const rawLen = headers["content-length"]
  const contentLength = rawLen ? Number(rawLen) : undefined

  // Cloudflare defines `cf-mitigated: challenge` as an authoritative Challenge
  // Page signal. Escalate as soon as the headers arrive instead of waiting for
  // an unbounded/keep-alive response body to finish (or hit the 30s socket timeout).
  // Body-based detection below remains the fallback for challenge variants that
  // do not send this header.
  const headerChallengeType = detectChallengeType("", headers, status)
  if (
    !skipChallengeDetection &&
    (headerChallengeType === "cloudflare-interstitial" ||
      headerChallengeType === "aws-waf" ||
      headerChallengeType === "datadome")
  ) {
    socket.destroy()
    return {
      mode: "buffer",
      status,
      headers,
      contentType,
      contentLength,
      body: Buffer.alloc(0),
      challengeDetected: true,
    }
  }

  const streamDecision = shouldStream(url, contentLength, contentType)

  const isChunked = (headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")
  if (streamDecision.stream) {
    const prefix = headerBuf.leftover?.length ? headerBuf.leftover : undefined
    return {
      mode: "stream",
      status,
      headers,
      contentType,
      contentLength,
      socket,
      prefix,
    }
  }

  if (isChunked || contentLength === undefined) {
    // Ordinary HTML/JSON/text responses are buffered to completion. This is
    // required both for valid chunk decoding and challenge detection.
    const initial = headerBuf.leftover ?? Buffer.alloc(0)
    const remaining = isChunked ? await readCompleteChunkedBody(socket, initial) : await drainSocket(socket)
    socket.destroy()
    const wireBody = isChunked ? remaining : Buffer.concat([initial, remaining])
    let body: Buffer
    try {
      body = isChunked ? decodeChunkedBody(wireBody) : wireBody
    } catch (err) {
      return { mode: "error", error: err instanceof Error ? err : new Error(String(err)) }
    }
    const previewText = decodeForInspection(body, headers["content-encoding"])
    const challengeType = detectChallengeType(previewText, headers, status)
    const challengeDetected = !skipChallengeDetection && isChallengeWall(status, body.length, challengeType)
    return {
      mode: "buffer",
      status,
      headers,
      contentType,
      contentLength: body.length,
      body,
      challengeDetected,
    }
  }

  // Buffer the body up to Content-Length. Use leftover bytes from the header
  // read first (they were received in the same TCP segment as the headers).
  const body = Buffer.alloc(contentLength)
  let offset = 0
  if (headerBuf.leftover && headerBuf.leftover.length > 0) {
    const toCopy = Math.min(headerBuf.leftover.length, contentLength)
    headerBuf.leftover.copy(body, 0, 0, toCopy)
    offset = toCopy
    if (headerBuf.leftover.length > toCopy) {
      // Upstream sent more body bytes than Content-Length declared.
      socket.destroy()
      return {
        mode: "buffer",
        status,
        headers,
        contentType,
        contentLength,
        body: body.subarray(0, offset),
        challengeDetected: false,
      }
    }
  }
  while (offset < contentLength) {
    const { chunk } = await readChunk(socket)
    if (!chunk) {
      socket.destroy()
      return {
        mode: "error",
        error: new Error(`upstream closed before Content-Length was satisfied (${offset}/${contentLength})`),
      }
    }
    const toCopy = Math.min(chunk.length, contentLength - offset)
    chunk.copy(body, offset, 0, toCopy)
    offset += toCopy
    if (chunk.length > toCopy) {
      // Upstream sent more than Content-Length declared. Stop reading, close.
      socket.destroy()
      break
    }
  }
  socket.destroy()

  // Challenge detection on the buffered body. Bounded preview keeps this cheap.
  const previewText = decodeForInspection(body.subarray(0, offset), headers["content-encoding"])
  const challengeType = detectChallengeType(previewText, headers)
  const challengeDetected = !skipChallengeDetection && isChallengeWall(status, body.length, challengeType)

  return {
    mode: "buffer",
    status,
    headers,
    contentType,
    contentLength,
    body: body.subarray(0, offset),
    challengeDetected,
  }
}

// Read bytes from the socket until we find `delimiter` or hit `maxBytes`.
async function readUpTo(
  socket: net.Socket,
  maxBytes: number,
  delimiter: string,
  initial: Buffer = Buffer.alloc(0),
): Promise<{ found: boolean; text: string; leftover?: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = initial.length > 0 ? [initial] : []
    let total = initial.length

    const inspect = (): boolean => {
      const buf = Buffer.concat(chunks, total)
      const idx = buf.indexOf(delimiter)
      if (idx >= 0) {
        // Stop flowing before handing control back. Otherwise a small response
        // can emit its body/end between this callback and the caller attaching
        // the body listeners.
        socket.pause()
        socket.off("data", onData)
        socket.off("error", onError)
        const endIdx = idx + delimiter.length
        const leftover = endIdx < buf.length ? buf.subarray(endIdx) : undefined
        resolve({ found: true, text: buf.subarray(0, endIdx).toString("latin1"), leftover })
        return true
      }
      if (total > maxBytes) {
        socket.off("data", onData)
        socket.off("error", onError)
        resolve({ found: false, text: buf.toString("latin1") })
        return true
      }
      return false
    }
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      inspect()
    }
    const onError = (err: Error) => {
      socket.off("data", onData)
      socket.off("error", onError)
      reject(err)
    }

    socket.on("data", onData)
    socket.once("error", onError)
    if (!inspect()) socket.resume()
  })
}

async function readChunk(socket: net.Socket) {
  return new Promise<{ chunk?: Buffer }>((resolve) => {
    const onData = (chunk: Buffer) => {
      socket.off("data", onData)
      socket.off("end", onEnd)
      socket.off("error", onError)
      resolve({ chunk })
    }
    const onEnd = () => {
      socket.off("data", onData)
      socket.off("end", onEnd)
      socket.off("error", onError)
      resolve({})
    }
    const onError = () => {
      socket.off("data", onData)
      socket.off("end", onEnd)
      socket.off("error", onError)
      resolve({})
    }
    socket.once("data", onData)
    socket.once("end", onEnd)
    socket.once("error", onError)
    socket.resume()
  })
}

// Drain everything remaining on the socket into a single Buffer. Used after
// challenge detection to capture the full challenge HTML before escalation.
async function drainSocket(socket: net.Socket): Promise<Buffer> {
  const chunks: Buffer[] = []
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => chunks.push(chunk)
    const finish = () => {
      socket.off("data", onData)
      socket.off("end", onFinish)
      socket.off("error", onFinish)
      resolve(Buffer.concat(chunks))
    }
    const onFinish = () => finish()
    socket.on("data", onData)
    socket.once("end", onFinish)
    socket.once("error", onFinish)
    socket.resume()
  })
}

async function readCompleteChunkedBody(socket: net.Socket, initial: Buffer): Promise<Buffer> {
  try {
    decodeChunkedBody(initial)
    return initial
  } catch {
    // The first packet commonly contains only part of the chunked body.
  }

  return new Promise((resolve) => {
    const chunks = initial.length ? [initial] : []
    let total = initial.length
    const finish = () => {
      socket.off("data", onData)
      socket.off("end", onEnd)
      socket.off("error", onEnd)
      resolve(Buffer.concat(chunks, total))
    }
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      try {
        decodeChunkedBody(Buffer.concat(chunks, total))
        finish()
      } catch {
        // Keep reading until the terminating zero-size chunk arrives.
      }
    }
    const onEnd = () => finish()
    socket.on("data", onData)
    socket.once("end", onEnd)
    socket.once("error", onEnd)
    socket.resume()
  })
}

function decodeChunkedBody(wire: Buffer): Buffer {
  const chunks: Buffer[] = []
  let offset = 0

  while (offset < wire.length) {
    const lineEnd = wire.indexOf("\r\n", offset)
    if (lineEnd < 0) throw new Error("invalid chunked response: missing chunk-size terminator")
    const sizeText = wire.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0]?.trim() ?? ""
    const size = Number.parseInt(sizeText, 16)
    if (!Number.isFinite(size) || size < 0) throw new Error(`invalid chunked response size: ${sizeText}`)
    offset = lineEnd + 2

    if (size === 0) return Buffer.concat(chunks)
    if (offset + size + 2 > wire.length) throw new Error("invalid chunked response: truncated chunk")
    chunks.push(wire.subarray(offset, offset + size))
    offset += size
    if (wire.subarray(offset, offset + 2).toString("ascii") !== "\r\n") {
      throw new Error("invalid chunked response: missing chunk terminator")
    }
    offset += 2
  }

  throw new Error("invalid chunked response: missing final chunk")
}

function decodeForInspection(body: Buffer, contentEncoding?: string): string {
  let decoded = body
  try {
    const encoding = contentEncoding?.split(",", 1)[0]?.trim().toLowerCase()
    if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(body)
    else if (encoding === "deflate") decoded = inflateSync(body)
    else if (encoding === "br") decoded = brotliDecompressSync(body)
  } catch {
    // If an upstream mislabeled or truncated the encoding, inspect the raw bytes.
  }
  return decoded.toString("utf8", 0, Math.min(decoded.length, 4096))
}
