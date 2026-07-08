import type { BrowserHandle } from "@trawl/browser"
import type { Cookie, SessionData, TierResult } from "@trawl/types"
import { isBlocked, isBrowserErrorPage, isCloudflarePage } from "./detect"
import { normalizeHtml } from "./html"
import type { RouteLike } from "./sanitize"
import { routeContinueOverrides } from "./sanitize"
import { solvePageCaptchas } from "./solvers"

export interface Tier2Result extends TierResult {
  tier: 2
  html?: string
  cookies?: Cookie[]
  statusCode?: number
  captchasSolved?: string[]
}

// Playwright's cookie.sameSite is `"Strict" | "Lax" | "None"` but can be undefined when
// the cookie was set without an explicit sameSite. Normalize to the Playwright literal
// union with a default of "Lax" (matches browser default for same-origin cookies).
function normalizeSameSite(s: string | undefined): "Strict" | "Lax" | "None" {
  return s === "Strict" || s === "Lax" || s === "None" ? s : "Lax"
}

export async function runTier2(
  url: string,
  handle: BrowserHandle,
  session: SessionData,
  maxTimeout: number,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
): Promise<Tier2Result> {
  const start = Date.now()
  const page = await handle.context.newPage()

  try {
    // addCookies replaces cookies by name+domain+path, so no need to clearCookies first.
    // Keeping the context's CF cookies (cf_clearance, __cf_bm) intact means CF sees a
    // browser with history, which speeds up challenge evaluation on the next Tier 3 run.
    await handle.context.addCookies(
      session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: normalizeSameSite(c.sameSite),
      })),
    )

    await page.setExtraHTTPHeaders({ "User-Agent": session.userAgent })

    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    let statusCode = 200
    page.on("response", (res: { url(): string; status(): number }) => {
      if (res.url() === url) statusCode = res.status()
    })

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: maxTimeout })
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})

    const html = await page.content()

    if (isBrowserErrorPage(html)) {
      return {
        tier: 2,
        status: "error",
        durationMs: Date.now() - start,
        reason: "browser network error (about:neterror)",
      }
    }

    if (isCloudflarePage(html, {})) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: "session-expired" }
    }

    if (isBlocked(statusCode, html)) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: `http-${statusCode}` }
    }

    // Attempt to solve any embedded captcha widgets (Turnstile, reCAPTCHA, hCaptcha).
    // Pages that load cleanly via session cache may still have in-page challenge widgets.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = []
    if (solveRemaining > 5000) {
      const result = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = result.solved
    }

    const rawCookies = await handle.context.cookies()
    const cookies: Cookie[] = rawCookies.map(
      (c: {
        name: string
        value: string
        domain: string
        path: string
        expires: number
        httpOnly: boolean
        secure: boolean
        sameSite?: string
      }) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires ?? -1,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }),
    )

    return {
      tier: 2,
      status: "success",
      durationMs: Date.now() - start,
      html: normalizeHtml(html),
      cookies,
      statusCode,
      captchasSolved: captchasSolved.length > 0 ? captchasSolved : undefined,
    }
  } catch (err) {
    return {
      tier: 2,
      status: "error",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await page.close().catch(() => {})
  }
}
