import { parseHTML } from "linkedom"
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

const CHARSET_PATTERN = /^\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i

const responseCharset = (contentType: string): string | undefined => {
  const parameters = contentType.match(/(?:[^;"']|"[^"]*"|'[^']*')+/g) ?? []
  for (const parameter of parameters.slice(1)) {
    const charset = CHARSET_PATTERN.exec(parameter)
    if (charset) return charset[1] ?? charset[2] ?? charset[3] ?? ""
  }
  return undefined
}

const hasNonAscii = (value: string): boolean => {
  for (const char of value) if ((char.codePointAt(0) ?? 0) > 0x7f) return true
  return false
}

const fragmentContent = (html: string): string => {
  const { document } = parseHTML(html)
  const root = document.documentElement?.localName === "html" ? document.body : document
  const styles = [...document.querySelectorAll("style,link")].map((element) => element.toString()).join("")
  const attributes = root === document ? [] : [...document.body.attributes].map(({ name, value }) => [name, value])
  for (const element of document.querySelectorAll("script,style,link,meta,iframe,frame,object,embed")) element.remove()
  const content = [...root.childNodes]
    .filter((node) => node.nodeType !== 10)
    .map((node) => node.toString())
    .join("")
  return JSON.stringify([attributes, normalizeHtml(styles), normalizeHtml(content)])
}

export const isCharsetLessUtf8HtmlFragment = (
  contentType: string | undefined,
  body?: Uint8Array,
  pageHtml?: string,
): boolean => {
  if (
    body === undefined ||
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "text/html" ||
    responseCharset(contentType) !== undefined
  )
    return false
  let markup: string
  try {
    markup = new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch {
    return false
  }
  if (!hasNonAscii(markup) || !/<[a-z][a-z0-9-]*(?=[\s/>])/i.test(markup)) return false
  if (/<(?:html|head|body|title|meta|base|frameset|iframe|frame|object|embed)(?=[\s/>])/i.test(markup)) return false
  if (/<!doctype\b|<script(?=[\s/>])|[\s/]on[a-z]+\s*=/i.test(markup)) {
    if (pageHtml === undefined) return false
    // Passive injected scripts may leave only Firefox's fallback decoding different.
    const rendered = fragmentContent(pageHtml)
    return (
      fragmentContent(markup) === rendered || fragmentContent(new TextDecoder("windows-1252").decode(body)) === rendered
    )
  }
  return true
}

export const decodeTextBody = (body: Uint8Array, contentType: string): string => {
  const charset = responseCharset(contentType)
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset ?? "utf-8")
  } catch {
    decoder = new TextDecoder("utf-8")
  }
  return decoder.decode(body)
}

export const isNonHtmlTextContentType = (contentType: string | undefined): boolean =>
  !!contentType && isTextContentType(contentType) && !isHtmlContentType(contentType)

export const browserDocumentHtml = (contentType: string | undefined, pageHtml: string, body?: Uint8Array): string => {
  if (contentType && !isTextContentType(contentType)) return ""
  if (body !== undefined && contentType) {
    if (isCharsetLessUtf8HtmlFragment(contentType, body, pageHtml) || !isHtmlContentType(contentType))
      return decodeTextBody(body, contentType)
  }
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
