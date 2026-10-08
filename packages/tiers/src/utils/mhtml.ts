import { randomBytes } from "node:crypto"

// Firefox exposes no equivalent of Chromium's Page.captureSnapshot, so the archive is
// assembled from the subresources the response listener already observed rather than
// serialized by the engine. It is a valid multipart/related document, not a byte-faithful
// snapshot: anything the browser served from cache, fetched before the listener attached,
// or refused to hand over is absent, and the omission part records what is missing.
const ARCHIVED_RESOURCE_TYPES = new Set(["document", "stylesheet", "script", "image", "font"])

const DEFAULT_CONTENT_TYPES: Record<string, string> = {
  document: "text/html",
  stylesheet: "text/css",
  script: "application/javascript",
  image: "application/octet-stream",
  font: "application/octet-stream",
}

// Longest line a quoted-printable or base64 part may use, per RFC 2045.
const MAX_LINE_CHARS = 76

// A header line is not folded, so a Content-Location longer than this is not archivable -
// folding a URL is what makes an MHTML unreadable in the browsers that reject it.
export const MAX_LOCATION_CHARS = 2_000

export type MhtmlOmissionReason =
  | "over-part-budget"
  | "archive-budget-exhausted"
  | "part-count-cap"
  | "read-slots-busy"
  | "unsafe-content-encoding"
  | "unknown-content-length"
  | "body-read-failed"
  | "location-too-long"

export interface MhtmlPart {
  location: string
  contentType: string
  encoding: "quoted-printable" | "base64"
  content: string
}

export interface MhtmlOmission {
  location: string
  reason: MhtmlOmissionReason
}

export const isArchivableResourceType = (resourceType: string): boolean => ARCHIVED_RESOURCE_TYPES.has(resourceType)

export const defaultContentType = (resourceType: string): string =>
  DEFAULT_CONTENT_TYPES[resourceType] ?? "application/octet-stream"

/** Strips anything a header line cannot carry - a line break above all. */
const headerSafe = (value: string, maxChars = MAX_LOCATION_CHARS): string => {
  let safe = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const encoded = code >= 0x20 && code <= 0x7e ? char : encodeURIComponent(char)
    if (safe.length + encoded.length > maxChars) break
    safe += encoded
  }
  return safe
}

const wrap = (value: string): string => {
  const lines: string[] = []
  for (let at = 0; at < value.length; at += MAX_LINE_CHARS) lines.push(value.slice(at, at + MAX_LINE_CHARS))
  return lines.join("\r\n")
}

const HEX = "0123456789ABCDEF"

const escaped = (byte: number): string => `=${HEX[byte >> 4]}${HEX[byte & 0xf]}`

/**
 * RFC 2045 quoted-printable, over the raw bytes rather than a decoded string, so a part
 * whose charset is not UTF-8 stays byte-faithful under its own declared charset.
 */
export const toQuotedPrintable = (raw: Buffer): string => {
  const lines: string[] = []
  let line = ""

  const push = (token: string) => {
    if (line.length + token.length > MAX_LINE_CHARS - 1) {
      lines.push(`${line}=`)
      line = ""
    }
    line += token
  }

  const breakLine = () => {
    // Trailing whitespace would be eaten by a transport that rewraps lines.
    const last = line.at(-1)
    if (last === " " || last === "\t") {
      line = line.slice(0, -1)
      push(escaped(last === " " ? 0x20 : 0x09))
    }
    lines.push(line)
    line = ""
  }

  for (let at = 0; at < raw.length; at++) {
    const byte = raw[at]
    if (byte === 0x0d && raw[at + 1] === 0x0a) {
      at++
      breakLine()
    } else if (byte === 0x0a || byte === 0x0d) {
      breakLine()
    } else if (byte === 0x3d || byte < 0x20 || byte > 0x7e) {
      push(escaped(byte))
    } else {
      push(String.fromCharCode(byte))
    }
  }

  breakLine()
  return lines.join("\r\n")
}

export const encodePart = (raw: Buffer, asText: boolean): Pick<MhtmlPart, "encoding" | "content"> =>
  asText
    ? { encoding: "quoted-printable", content: toQuotedPrintable(raw) }
    : { encoding: "base64", content: wrap(raw.toString("base64")) }

const omissionPart = (omissions: MhtmlOmission[], omitted: number): string => {
  const listed = omissions.map((o) => `${o.reason} ${headerSafe(o.location)}`).join("\r\n")
  const unlisted = omitted > omissions.length ? `\r\n(${omitted - omissions.length} further omissions not listed)` : ""
  return `${omitted} resource(s) omitted from this archive.\r\n${listed}${unlisted}`
}

export interface MhtmlDocument {
  url: string
  html: string
  parts: MhtmlPart[]
  omissions: MhtmlOmission[]
  omitted: number
}

/**
 * Assembles one multipart/related archive with the main document first. The boundary is
 * checked against every part so no content can terminate the archive early.
 */
export function assembleMhtml(document: MhtmlDocument): string {
  const main: MhtmlPart = {
    location: document.url,
    contentType: "text/html; charset=utf-8",
    ...encodePart(Buffer.from(document.html, "utf8"), true),
  }
  const parts = [main, ...document.parts.filter((part) => part.location !== document.url)]
  if (document.omitted > 0) {
    parts.push({
      location: "",
      contentType: "text/plain; charset=utf-8",
      ...encodePart(Buffer.from(omissionPart(document.omissions, document.omitted), "utf8"), true),
    })
  }

  let boundary = ""
  for (let attempt = 0; attempt < 4; attempt++) {
    boundary = `----MultipartBoundary--trawl${randomBytes(12).toString("hex")}----`
    if (!parts.some((part) => part.content.includes(boundary))) break
  }

  const header = [
    "From: <Saved by TRAWL>",
    `Snapshot-Content-Location: ${headerSafe(document.url)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "X-Trawl-Archive: assembled-from-observed-subresources",
    ...(document.omitted > 0 ? [`X-Trawl-Omitted-Resources: ${document.omitted}`] : []),
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
  ].join("\r\n")

  const body = parts
    .map((part) =>
      [
        `--${boundary}`,
        `Content-Type: ${headerSafe(part.contentType, 200)}`,
        `Content-Transfer-Encoding: ${part.encoding}`,
        part.location
          ? `Content-Location: ${headerSafe(part.location)}`
          : "Content-ID: <trawl-omitted-resources@trawl.invalid>",
        "",
        part.content,
        "",
      ].join("\r\n"),
    )
    .join("")

  return `${header}\r\n\r\n${body}--${boundary}--\r\n`
}

/**
 * Fits the complete serialized archive under its configured response limit. Resources
 * are retained in arrival order and omitted whole; if the rendered root cannot fit even
 * with a minimal omission summary, no archive is returned.
 */
export function assembleBoundedMhtml(
  document: MhtmlDocument,
  maxChars: number,
  maxOmissionRecords: number,
): string | undefined {
  if (maxChars <= 0) return undefined
  const candidates = document.parts.filter((part) => part.location !== document.url)

  const render = (partCount: number, omissionRecordCount: number): string =>
    assembleMhtml({
      ...document,
      parts: candidates.slice(0, partCount),
      omissions: document.omissions.slice(0, Math.min(omissionRecordCount, maxOmissionRecords)),
      omitted: document.omitted + candidates.length - partCount,
    })

  const complete = render(candidates.length, document.omissions.length)
  if (complete.length <= maxChars) return complete

  let low = 0
  let high = candidates.length
  let best: string | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const archive = render(middle, document.omissions.length)
    if (archive.length <= maxChars) {
      best = archive
      low = middle + 1
    } else high = middle - 1
  }
  if (best) return best

  low = 0
  high = Math.min(document.omissions.length, maxOmissionRecords)
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const archive = render(0, middle)
    if (archive.length <= maxChars) {
      best = archive
      low = middle + 1
    } else high = middle - 1
  }
  return best
}
