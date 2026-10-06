import type { BlockedEvidence, ScrapeResult } from "@trawl/types"

export interface ProxyBufferedResponse {
  body: Buffer
  contentType: string
  headers: Record<string, string>
}

export interface ProxyBlockedResponse {
  body: Buffer
  contentType: string
  headers: Record<string, string>
  statusCode: number
}

const BODYLESS_STATUS_CODES = new Set([204, 205, 304])

const TRANSFORMED_BODY_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-md5",
  "content-range",
  "accept-ranges",
  "etag",
  "transfer-encoding",
])

function isHtml(contentType: string): boolean {
  const base = contentType.split(";", 1)[0]?.trim().toLowerCase()
  return base === "text/html" || base === "application/xhtml+xml"
}

function utf8ContentType(contentType: string): string {
  // Keep other MIME parameters, including quoted values containing semicolons.
  const parts = contentType.match(/(?:[^;"']|"[^"]*"|'[^']*')+/g) ?? []
  const retained = parts.map((part) => part.trim()).filter((part, index) => index === 0 || !/^charset\s*=/i.test(part))
  return `${retained.join("; ")}; charset=utf-8`
}

export function responseFromScrapeResult(result: ScrapeResult): ProxyBufferedResponse {
  const upstreamContentType =
    result.contentType ?? result.responseHeaders?.["content-type"] ?? "text/html; charset=utf-8"
  const useRenderedHtml =
    isHtml(upstreamContentType) && result.html.length > 0 && (result.tier >= 2 || result.body === undefined)
  const contentType = useRenderedHtml ? utf8ContentType(upstreamContentType) : upstreamContentType
  // Playwright exposes browser response bodies after content decoding while
  // retaining the upstream representation headers. Those headers cannot be
  // forwarded with the decoded bytes. Tier 1, by contrast, carries wire bytes.
  const bodyWasTransformed = useRenderedHtml || result.tier >= 2
  const body = useRenderedHtml
    ? Buffer.from(result.html, "utf8")
    : result.body
      ? Buffer.from(result.body)
      : Buffer.from(result.html, "utf8")

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(result.responseHeaders ?? {})) {
    const lower = name.toLowerCase()
    if (bodyWasTransformed && TRANSFORMED_BODY_HEADERS.has(lower)) continue
    headers[lower] = value
  }
  headers["content-type"] = contentType

  return { body, contentType, headers }
}

export function responseFromBlockedEvidence(evidence: BlockedEvidence): ProxyBlockedResponse {
  let statusCode =
    Number.isInteger(evidence.statusCode) &&
    evidence.statusCode !== undefined &&
    evidence.statusCode >= 200 &&
    evidence.statusCode < 600 &&
    !BODYLESS_STATUS_CODES.has(evidence.statusCode)
      ? evidence.statusCode
      : 403

  if (evidence.reason?.startsWith("anubis-") && statusCode < 400) {
    statusCode = evidence.status === "timeout" ? 504 : 403
  }

  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "x-trawl-status": "blocked",
  }
  if (evidence.reason) {
    headers["x-trawl-reason"] = evidence.reason
  }

  const body = Buffer.from(evidence.html, "utf8")
  return { body, contentType: "text/html; charset=utf-8", headers, statusCode }
}
