import { Readability } from "@mozilla/readability"
import { isHtmlContentType } from "@trawl/tiers"
import type {
  ExtractionOptions,
  ExtractResponse,
  PageMetadata,
  ReadOptions,
  ReadResponse,
  ScrapeResult,
} from "@trawl/types"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"
import { extractFields } from "./extraction"

export const READ_DEFAULT_MAX_CHARACTERS = 50_000
export const READ_MAX_CHARACTERS = 100_000

export function pageContentType(result: ScrapeResult): string {
  return result.contentType ?? result.responseHeaders?.["content-type"] ?? "text/html"
}

export function pageMetadata(result: ScrapeResult): PageMetadata {
  return {
    url: result.url,
    statusCode: result.statusCode,
    tier: result.tier,
    contentType: pageContentType(result),
    totalMs: result.totalMs,
    ...(result.waf ? { waf: result.waf } : {}),
  }
}

function extractReadable(html: string, url: string, format: "markdown" | "text") {
  let { document } = parseHTML(html)
  if (document.documentElement?.localName !== "html") document = parseHTML(`<html><body>${html}</body></html>`).document
  const parsed = new Readability(document as unknown as Document).parse()
  const title = parsed?.title?.trim() || document.title?.trim() || url
  const articleHtml = parsed?.content || document.body?.innerHTML || html
  const text =
    format === "markdown"
      ? new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(articleHtml)
      : parsed?.textContent?.trim() || document.body?.textContent?.trim() || ""
  return {
    text,
    title,
    ...(parsed?.byline ? { byline: parsed.byline } : {}),
    ...(parsed?.excerpt ? { excerpt: parsed.excerpt } : {}),
    ...(parsed?.siteName ? { siteName: parsed.siteName } : {}),
    ...(parsed?.lang ? { language: parsed.lang } : {}),
  }
}

export function readPage(
  result: ScrapeResult,
  { format = "markdown", maxCharacters = READ_DEFAULT_MAX_CHARACTERS }: ReadOptions,
): ReadResponse {
  const article = isHtmlContentType(pageContentType(result))
    ? extractReadable(result.html, result.url, format)
    : undefined
  const { text: fullText, ...details } = article ?? { title: result.url, text: result.html }
  const text = fullText.slice(0, maxCharacters)
  return {
    ...pageMetadata(result),
    ...details,
    text,
    format,
    characters: text.length,
    truncated: fullText.length > maxCharacters,
  }
}

export function extractPage(
  result: ScrapeResult,
  { itemSelector, fields, maxItems = 25 }: ExtractionOptions,
): ExtractResponse {
  return { ...pageMetadata(result), ...extractFields(result.html, itemSelector, fields, maxItems) }
}
