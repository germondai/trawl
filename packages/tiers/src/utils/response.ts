import { normalizeHtml } from "./html"

export interface MinimalResponse {
  url(): string
  status(): number
  headers(): Record<string, string>
  allHeaders(): Promise<Record<string, string>>
  body(): Promise<Buffer | Uint8Array>
}

export interface CapturedResponse {
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
}

const TEXT_CONTENT_MARKERS = ["html", "xml", "json", "javascript", "ecmascript", "x-www-form-urlencoded"]

export const isTextContentType = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase()
  return normalized.startsWith("text/") || TEXT_CONTENT_MARKERS.some((marker) => normalized.includes(marker))
}

export const isHtmlContentType = (contentType: string | undefined): boolean => {
  if (!contentType) return false
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase()
  return mediaType === "text/html" || mediaType === "application/xhtml+xml"
}

export const decodeTextBody = (body: Uint8Array, contentType: string): string => {
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(contentType)
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? "utf-8")
  } catch {
    decoder = new TextDecoder("utf-8")
  }
  return decoder.decode(body)
}

export const isNonHtmlTextContentType = (contentType: string | undefined): boolean =>
  !!contentType && isTextContentType(contentType) && !isHtmlContentType(contentType)

// Use the captured file for non-HTML text; retain the rendered DOM for HTML.
export const browserDocumentHtml = (contentType: string | undefined, pageHtml: string, body?: Uint8Array): string => {
  if (contentType && !isTextContentType(contentType)) return ""
  if (body !== undefined && contentType && !isHtmlContentType(contentType)) return decodeTextBody(body, contentType)
  return normalizeHtml(pageHtml)
}

export const captureResponse = async (response?: MinimalResponse): Promise<CapturedResponse> => {
  if (!response) return {}
  try {
    const raw = await response.body()
    const responseHeaders = await response.allHeaders()
    return {
      body: raw instanceof Uint8Array ? raw : new Uint8Array(raw),
      responseHeaders,
      contentType: responseHeaders["content-type"] ?? "application/octet-stream",
    }
  } catch {
    return {}
  }
}
