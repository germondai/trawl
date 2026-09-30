import type { Page } from "patchright"
import { isHardNetworkFailure } from "./network"

// A refresh further out than this is a page that reloads itself on a timer (Cloudflare's
// challenge carries `content="360"`), not one that exists to send the browser elsewhere.
export const MAX_REFRESH_DELAY_MS = 10_000
// Lure → kit is one hop; a chain longer than this is a loop, not a funnel.
export const MAX_REFRESH_HOPS = 3
// How long past its own delay the browser gets to fire the refresh before we navigate.
const FIRE_GRACE_MS = 2_000

export interface MetaRefresh {
  delayMs: number
  url: string
}

const META_TAG = /<meta\b[^>]*>/gi

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

// The http(s) url a `<meta http-equiv="refresh">` sends the page to, resolved against
// `baseUrl`. Undefined for a refresh that names no url (a reload of the same page), a
// non-http target, or no refresh at all.
export function metaRefreshTarget(html: string, baseUrl: string): MetaRefresh | undefined {
  for (const tag of html.match(META_TAG) ?? []) {
    if (attribute(tag, "http-equiv")?.trim().toLowerCase() !== "refresh") continue
    const content = attribute(tag, "content")
    if (!content) continue
    const match = /^\s*(\d+(?:\.\d+)?)?\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/is.exec(content)
    const target = match?.[2]?.trim().replace(/^['"]|['"]$/g, "")
    if (!target) continue
    let resolved: URL
    try {
      resolved = new URL(target, baseUrl)
    } catch {
      continue
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue
    return { delayMs: Math.round(Number(match?.[1] ?? 0) * 1000), url: resolved.toString() }
  }
  return undefined
}

// Follows the page's meta refreshes, up to MAX_REFRESH_HOPS, within `budgetMs`. The
// browser is given the refresh's own delay (plus a grace) to fire it; if it has not, the
// tier navigates there itself, in the same context so the proxy and cookies carry over.
// Returns the url the page ended on when at least one refresh was followed, else
// undefined. A hard network failure, or a navigation that leaves the page where it was,
// stops the walk there.
export async function followMetaRefresh(page: Page, budgetMs: number): Promise<string | undefined> {
  const deadline = Date.now() + budgetMs
  let followed: string | undefined
  for (let hop = 0; hop < MAX_REFRESH_HOPS; hop++) {
    const from = page.url()
    const refresh = metaRefreshTarget(await page.content().catch(() => ""), from)
    if (!refresh || refresh.delayMs > MAX_REFRESH_DELAY_MS || refresh.url === from) break
    const left = deadline - Date.now()
    if (left <= 0) break

    console.log(`[metaRefresh] following ${from} -> ${refresh.url} (delay ${refresh.delayMs}ms)`)
    const fired = await page
      .waitForURL((u) => u.toString() !== from, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(left, refresh.delayMs + FIRE_GRACE_MS),
      })
      .then(
        () => true,
        () => false,
      )
    if (!fired) {
      const gotoErr = await page
        .goto(refresh.url, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, Math.min(deadline - Date.now(), 30_000)),
        })
        .then(
          () => undefined,
          (e: Error) => e,
        )
      if (isHardNetworkFailure(gotoErr)) break
    }
    // A goto that timed out leaves the page where it was; reading the same refresh
    // again would only spend the budget the challenge wait needs.
    if (page.url() === from) break
    followed = page.url()
  }
  return followed
}
