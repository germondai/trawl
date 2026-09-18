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

export function responseFromScrapeResult(result: ScrapeResult): ProxyBufferedResponse {
  const contentType = result.contentType ?? result.responseHeaders?.["content-type"] ?? "text/html; charset=utf-8"
  const useRenderedHtml = isHtml(contentType) && result.html.length > 0
  // Fetch and browser response bodies are exposed after content decoding while
  // retaining the upstream representation headers. Those headers cannot be
  // forwarded with the decoded bytes.
  const bodyWasTransformed = useRenderedHtml || result.tier >= 1
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
  const statusCode =
    Number.isInteger(evidence.statusCode) &&
    evidence.statusCode !== undefined &&
    evidence.statusCode >= 200 &&
    evidence.statusCode < 600 &&
    !BODYLESS_STATUS_CODES.has(evidence.statusCode)
      ? evidence.statusCode
      : 403

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
