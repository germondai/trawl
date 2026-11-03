import { RequestValidationError } from "@trawl/tiers"
import type { ExtractionField } from "@trawl/types"
import { parseHTML } from "linkedom"

const MAX_HTML_CHARS = 2_000_000
const MAX_OUTPUT_CHARS = 100_000
const MAX_VALUE_CHARS = 2_000

export function extractFields(
  html: string,
  itemSelector: string | undefined,
  fields: Record<string, ExtractionField>,
  maxItems: number,
): { items: Record<string, string | null>[]; matched: number; truncated: boolean } {
  if (html.length > MAX_HTML_CHARS) {
    throw new RequestValidationError(`Page HTML exceeds extraction limit of ${MAX_HTML_CHARS} characters`, 400)
  }

  const { document } = parseHTML(html)
  let roots: Array<Document | Element>
  try {
    roots = itemSelector ? Array.from(document.querySelectorAll(itemSelector)) : [document as Document]
  } catch {
    throw new RequestValidationError("Invalid itemSelector CSS selector", 400)
  }

  const items: Record<string, string | null>[] = []
  for (const root of roots.slice(0, maxItems)) {
    const item: Record<string, string | null> = {}
    for (const [name, field] of Object.entries(fields)) {
      let element: Element | null
      try {
        element = root.querySelector(field.selector)
      } catch {
        throw new RequestValidationError(`Invalid CSS selector for field ${name}`, 400)
      }
      const value = element
        ? field.attribute
          ? element.getAttribute(field.attribute)
          : element.textContent?.trim() || null
        : null
      item[name] = value?.slice(0, MAX_VALUE_CHARS) ?? null
    }
    if (JSON.stringify([...items, item]).length > MAX_OUTPUT_CHARS) break
    items.push(item)
  }

  return { items, matched: roots.length, truncated: items.length < roots.length }
}
