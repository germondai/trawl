import { STATUS_CODES } from "node:http"
import type net from "node:net"
import { RESPONSE_HOP_BY_HOP_HEADERS } from "@trawl/tiers"

function reason(status: number): string {
  return STATUS_CODES[status] ?? "Unknown Status"
}

export const responseHasBody = (status: number, method = "GET"): boolean =>
  method !== "HEAD" && status !== 204 && status !== 304 && status >= 200

function appendHeader(headerLines: string[], name: string, value: string): void {
  if (name.toLowerCase() !== "set-cookie") {
    headerLines.push(`${name}: ${value}`)
    return
  }
  for (const cookie of value.split(/\r?\n/)) {
    if (cookie.trim().length > 0) headerLines.push(`${name}: ${cookie}`)
  }
}

export function serializeResponseHeaders(
  status: number,
  upstreamHeaders: Record<string, string>,
  fallbackContentType: string,
  options: { bodyLength?: number; streamed?: boolean; requestBodyLength?: number; method?: string } = {},
): string {
  const headerLines: string[] = [`HTTP/1.1 ${status} ${reason(status)}`]
  const hasBody = responseHasBody(status, options.method)
  const preserveLength = (options.streamed && hasBody) || options.method === "HEAD" || status === 304
  let emittedContentType = false
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    if (RESPONSE_HOP_BY_HOP_HEADERS.has(lower) && !(options.streamed && hasBody && lower === "transfer-encoding"))
      continue
    if (!preserveLength && lower === "content-length") continue
    if (lower === "content-type") emittedContentType = true
    appendHeader(headerLines, name, value)
  }
  if (!emittedContentType) headerLines.push(`Content-Type: ${fallbackContentType}`)
  if (hasBody && options.bodyLength !== undefined) headerLines.push(`Content-Length: ${options.bodyLength}`)
  if ((options.requestBodyLength ?? 0) > 0) headerLines.push(`X-Forwarded-Body-Length: ${options.requestBodyLength}`)
  headerLines.push("Connection: close")
  return `${headerLines.join("\r\n")}\r\n\r\n`
}

export function writeResponse(
  sock: net.Socket,
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

export function writeResponseFromBuffer(
  sock: net.Socket,
  status: number,
  upstreamHeaders: Record<string, string>,
  body: Buffer,
  fallbackContentType: string,
  method = "GET",
): void {
  sock.write(
    serializeResponseHeaders(status, upstreamHeaders, fallbackContentType, { bodyLength: body.length, method }),
  )
  if (responseHasBody(status, method)) sock.write(body)
  sock.end()
}

export function writeResponseFromStream(
  sock: net.Socket,
  status: number,
  upstreamHeaders: Record<string, string>,
  upstreamSocket: net.Socket,
  fallbackContentType: string,
  requestBodyLength: number,
  prefix?: Buffer,
  method = "GET",
): void {
  sock.write(
    serializeResponseHeaders(status, upstreamHeaders, fallbackContentType, {
      streamed: true,
      requestBodyLength,
      method,
    }),
  )
  if (!responseHasBody(status, method)) {
    upstreamSocket.destroy()
    sock.end()
    return
  }
  if (prefix?.length) sock.write(prefix)
  upstreamSocket.pipe(sock)
  const closeUpstream = () => upstreamSocket.destroy()
  sock.once("close", closeUpstream)
  sock.once("error", closeUpstream)
  upstreamSocket.on("error", () => sock.destroy())
  upstreamSocket.on("end", () => sock.end())
  upstreamSocket.once("close", () => {
    sock.off("close", closeUpstream)
    sock.off("error", closeUpstream)
    sock.end()
  })
}
