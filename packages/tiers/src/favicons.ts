import type { FaviconEntry } from "@trawl/types"
import type { Page } from "patchright"
import { captureLimit } from "./utils/captureConfig"

// Favicons are a best-effort side artifact of a scrape, so every dimension is bounded:
// how many icons one page may yield, how large one icon may be, how long a single fetch
// may take, and how long the whole collection may take. All are env-tunable, and the
// caller's own remaining budget caps the last of them.
const MAX_ENTRIES = captureLimit(process.env.FAVICON_MAX_ENTRIES, 8)
const MAX_BYTES = captureLimit(process.env.FAVICON_MAX_BYTES, 524_288)
const FETCH_TIMEOUT_MS = captureLimit(process.env.FAVICON_FETCH_TIMEOUT_MS, 5_000)
const TOTAL_TIMEOUT_MS = captureLimit(process.env.FAVICON_TIMEOUT_MS, 20_000)

const TIMED_OUT = Symbol("favicon-collection-timed-out")

/**
 * Reads the page's favicons from inside the page that rendered it.
 *
 * A page may declare several icons — size and device variants, `apple-touch-icon`,
 * `mask-icon`, `shortcut icon` — and the browser renders exactly one of them. Everything
 * declared is collected here, plus the apex `/favicon.ico` whether or not the page points
 * at it, because that is the icon a browser falls back to and a page that declares none
 * still usually serves.
 *
 * Capturing them off the response stream does not work: a headless browser paints no tab,
 * so it requests at most the one icon it would have drawn and never the apex one, and a
 * page that declares no icon yields nothing at all. They are resolved and fetched
 * explicitly instead, and the fetch runs in page context so it carries the origin's
 * cookies, the session's challenge clearance and the same egress the page was served
 * over — an icon fetched afterwards from outside the browser knocks on the door as a
 * stranger, which is why bot walls answer it with a 403.
 *
 * Returns `[]` rather than throwing: a favicon that cannot be read degrades that field,
 * never the scrape.
 *
 * `budgetMs` is what is left of the request's `maxTimeout`. Collection never outlives it,
 * and is skipped outright once it is spent — the icons are worth a wait the caller still
 * has, never one it does not.
 */
export async function capturePageFavicons(page: Page, budgetMs = TOTAL_TIMEOUT_MS): Promise<FaviconEntry[]> {
  const windowMs = Math.min(budgetMs, TOTAL_TIMEOUT_MS)
  if (!(windowMs > 0)) {
    console.log("[favicons] skipped: the request's time budget is spent")
    return []
  }
  try {
    const collect = page.evaluate(
      async ({ maxEntries, maxBytes, fetchTimeoutMs }) => {
        // `fetch` is what the icon is read with, so a `data:` icon is read the same way
        // as any other. Its href is the payload rather than a name, though, so it is
        // reported by mime alone: repeating a megabyte of base64 in `url` next to the
        // `data` decoded from it buys nothing.
        const candidates: Array<{ target: string; label: string }> = []
        const seen = new Set<string>()

        const add = (href: string | null): void => {
          const raw = href?.trim()
          if (!raw) return
          let target: string
          let label: string
          if (raw.startsWith("data:")) {
            target = raw
            label = `data:${raw.slice(5).split(/[;,]/)[0] || "image/png"}`
          } else {
            try {
              const parsed = new URL(raw, document.baseURI)
              if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return
              target = parsed.href
              label = parsed.href
            } catch {
              return
            }
          }
          if (seen.has(target)) return
          seen.add(target)
          candidates.push({ target, label })
        }

        // The apex icon leads and is tried whether or not the page declares it: it is what
        // a browser falls back to, and a page with no `<link>` at all still commonly
        // serves one.
        if (location.protocol === "http:" || location.protocol === "https:") {
          add(new URL("/favicon.ico", location.origin).href)
        }
        // `rel` is matched as a substring so apple-touch-icon, mask-icon, shortcut icon
        // and alternate icon all count — the whole declared set, not just the one the
        // browser chose to paint.
        for (const link of Array.from(document.querySelectorAll("link[rel]"))) {
          if (!(link.getAttribute("rel") ?? "").toLowerCase().includes("icon")) continue
          add(link.getAttribute("href"))
        }

        // fetch() hands back whole bodies, so the only way to bound a read is to decline
        // to start it: an oversize icon is refused on its declared length, and base64
        // never shrinks, so a data: href past twice the cap cannot decode to within it.
        const oversize = (bytes: number): string => `${bytes} bytes exceeds the ${maxBytes} byte cap`

        const entries: Array<{ url: string; contentType?: string; data?: string; error?: string }> = []
        for (const { target, label } of candidates.slice(0, maxEntries)) {
          try {
            if (target.startsWith("data:") && target.length > maxBytes * 2) {
              entries.push({
                url: label,
                error: `an inline href of ${target.length} chars cannot decode within the ${maxBytes} byte cap`,
              })
              continue
            }
            const response = await fetch(target, { signal: AbortSignal.timeout(fetchTimeoutMs) })
            if (!response.ok) {
              entries.push({ url: label, error: `http-${response.status}` })
              continue
            }
            const declared = Number(response.headers.get("content-length"))
            if (declared > maxBytes) {
              entries.push({ url: label, error: oversize(declared) })
              continue
            }
            const bytes = new Uint8Array(await response.arrayBuffer())
            if (bytes.length === 0) {
              entries.push({ url: label, error: "empty body" })
              continue
            }
            if (bytes.length > maxBytes) {
              entries.push({ url: label, error: oversize(bytes.length) })
              continue
            }
            let binary = ""
            for (let offset = 0; offset < bytes.length; offset += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
            }
            entries.push({
              url: label,
              contentType: response.headers.get("content-type") ?? undefined,
              data: btoa(binary),
            })
          } catch (err) {
            entries.push({ url: label, error: err instanceof Error ? err.message : String(err) })
          }
        }
        return entries
      },
      { maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES, fetchTimeoutMs: Math.min(FETCH_TIMEOUT_MS, windowMs) },
    )

    // page.evaluate cannot be cancelled, so the race only stops this call waiting on it;
    // the evaluation itself dies with the page the tier closes in its `finally`.
    const outcome = await Promise.race([
      collect,
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), windowMs)),
    ])
    if (outcome === TIMED_OUT) {
      console.log(`[favicons] gave up after ${windowMs}ms`)
      return []
    }

    const failed = outcome.filter((entry) => entry.error)
    if (failed.length > 0) {
      console.log(`[favicons] ${failed.length} of ${outcome.length} unreadable: ${failed[0].url} ${failed[0].error}`)
    }
    return outcome
  } catch (err) {
    console.log(`[favicons] collection failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
