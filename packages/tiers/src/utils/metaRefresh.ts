import type { Page } from "patchright"
import type { OutboundUrlValidator } from "./outboundPolicy"

export const MAX_REFRESH_DELAY_MS = 10_000
export const MAX_REFRESH_HOPS = 3
const FIRE_GRACE_MS = 2_000

interface RefreshDocument {
  url: string
  baseUrl: string
  documentUrl?: string
  contents: string[]
}

export interface MetaRefresh {
  delayMs: number
  url: string
}

export type RefreshOutcome = { status: "ok"; url: string } | { status: "error" | "timeout"; reason: string }

function refreshTarget(document: RefreshDocument): MetaRefresh | undefined {
  for (const content of document.contents) {
    // A delay without a destination reloads the page and is not a redirect.
    const match = /^\s*(\d+(?:\.\d+)?)\s*[;,](.*)$/s.exec(content)
    if (!match) continue
    const delayMs = Math.round(Number(match[1]) * 1000)
    if (!Number.isFinite(delayMs) || delayMs > MAX_REFRESH_DELAY_MS) continue
    const target = match[2]
      ?.trim()
      .replace(/^url\s*=\s*/i, "")
      .trim()
      .replace(/^(["'])(.*)\1$/s, "$2")
    if (!target) continue
    try {
      const url = new URL(target, document.baseUrl)
      if ((url.protocol === "https:" || url.protocol === "http:") && url.href !== document.url) {
        return { delayMs, url: url.href }
      }
    } catch {
      // Invalid destinations do not represent a usable redirect.
    }
  }
  return undefined
}

/** Parse only opted-in HTTP HTML; ordinary requests never load the HTML parser. */
export async function metaRefreshTarget(html: string, url: string): Promise<MetaRefresh | undefined> {
  const { parseHTML } = await import("linkedom")
  const { document } = parseHTML(html)
  let baseUrl = url
  // Linkedom preserves attribute-name case, unlike a browser HTML DOM.
  const attribute = (element: Element, name: string): string | undefined =>
    Array.from(element.attributes).find((attr) => attr.name.toLowerCase() === name)?.value
  const base = Array.from(document.querySelectorAll("base")).find(
    (element) => !element.closest("template,noscript") && attribute(element, "href") !== undefined,
  )
  const href = base ? attribute(base, "href") : undefined
  if (href !== null && href !== undefined) {
    try {
      baseUrl = new URL(href, url).href
    } catch {
      // An invalid base falls back to the document URL.
    }
  }
  const contents = Array.from(document.querySelectorAll("meta"))
    .filter(
      (meta) => !meta.closest("template,noscript") && attribute(meta, "http-equiv")?.trim().toLowerCase() === "refresh",
    )
    .map((meta) => attribute(meta, "content") ?? "")
  return refreshTarget({ url, baseUrl, contents })
}

/** Follow in the existing context so cookies, proxy and outbound routes stay in force. */
export async function followMetaRefresh(
  page: Page,
  budgetMs: number,
  validate?: OutboundUrlValidator,
): Promise<RefreshOutcome> {
  const deadline = Date.now() + budgetMs
  const visited = new Set<string>()
  let hops = 0
  const timeout = (): RefreshOutcome => ({ status: "timeout", reason: "meta-refresh-timeout" })
  const withinBudget = async <T>(action: () => Promise<T>): Promise<T> => {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error("meta-refresh-timeout")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("meta-refresh-timeout")), left)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const interrupted = (error: unknown): error is Error =>
    error instanceof Error && /NS_BINDING_ABORTED|is interrupted by another navigation/.test(error.message)
  const waitForDestination = async (from: string): Promise<void> => {
    while (true) {
      try {
        await withinBudget(() =>
          page.waitForURL((url) => url.href !== from, {
            waitUntil: "domcontentloaded",
            timeout: Math.max(1, deadline - Date.now()),
          }),
        )
        return
      } catch (error) {
        if (!interrupted(error)) throw error
        // Firefox can report the canceled navigation to a newly installed waiter.
        await withinBudget(() => new Promise<void>((resolve) => setTimeout(resolve, 25)))
      }
    }
  }
  try {
    while (true) {
      if (Date.now() >= deadline) return timeout()
      // Read location and DOM together; an automatic redirect may already have fired.
      let document: RefreshDocument
      try {
        document = await withinBudget(() =>
          page.evaluate(() => ({
            url: window.location.href,
            baseUrl: window.document.baseURI,
            documentUrl: window.document.documentURI,
            contents: Array.from(window.document.querySelectorAll("meta[http-equiv]"))
              .filter((meta) => meta.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh")
              .map((meta) => meta.getAttribute("content") ?? ""),
          })),
        )
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Execution context was destroyed")) throw error
        // An immediate browser refresh can replace the context during evaluate.
        // Retry only that navigation race, within the same request deadline.
        await withinBudget(() => new Promise<void>((resolve) => setTimeout(resolve, 25)))
        continue
      }
      if (Date.now() >= deadline) return timeout()
      if (document.documentUrl && /^about:(?:neterror|certerror)/i.test(document.documentUrl)) {
        return { status: "error", reason: "meta-refresh-navigation-failed" }
      }
      const refresh = refreshTarget(document)
      if (!refresh) return { status: "ok", url: document.url }
      if (visited.has(document.url) || visited.has(refresh.url)) {
        return { status: "error", reason: "meta-refresh-loop" }
      }
      if (hops >= MAX_REFRESH_HOPS) return { status: "error", reason: "meta-refresh-hop-limit" }
      visited.add(document.url)
      // Check even when waiting for an automatic refresh. Browser routing validates
      // every actual request again, including intermediate HTTP redirects and assets.
      if (validate) await withinBudget(() => validate(refresh.url))
      if (Date.now() >= deadline) return timeout()
      let fired = false
      try {
        await page.waitForURL((url) => url.href !== document.url, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(deadline - Date.now(), refresh.delayMs + FIRE_GRACE_MS),
        })
        fired = true
      } catch (error) {
        if (interrupted(error)) {
          await waitForDestination(document.url)
          fired = true
        }
        // A timed-out automatic refresh may fall back only while budget remains.
      }
      if (Date.now() >= deadline) return timeout()
      if (!fired) {
        try {
          await page.goto(refresh.url, {
            waitUntil: "domcontentloaded",
            timeout: Math.min(deadline - Date.now(), 30_000),
          })
        } catch (error) {
          if (!interrupted(error)) throw error
          // A competing automatic navigation may win the fallback race. Require
          // its destination DOM to load; the next snapshot rejects error pages.
          await waitForDestination(document.url)
        }
      }
      if (page.url() === document.url) return { status: "error", reason: "meta-refresh-navigation-failed" }
      hops++
    }
  } catch {
    return Date.now() >= deadline ? timeout() : { status: "error", reason: "meta-refresh-navigation-failed" }
  }
}
