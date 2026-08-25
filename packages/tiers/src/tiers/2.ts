import type { BrowserHandle } from "@trawl/browser"
import type { Cookie, SessionData, TierResult } from "@trawl/types"
import { solvePageCaptchas } from "../solvers"
import { normalizeSameSite, toCookies } from "../utils/cookies"
import {
  hasAkamaiChallenge,
  hasDataDomeChallenge,
  isBlocked,
  isBrowserErrorPage,
  isCloudflarePage,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import { trackMainDocumentResponses } from "../utils/mainResponse"
import { captureResponse, isTextContentType } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"

export interface Tier2Result extends TierResult {
  tier: 2
  effectiveUrl?: string
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  cookies?: Cookie[]
  statusCode?: number
  captchasSolved?: string[]
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
  const activeContext = handle.context
  let page: Awaited<ReturnType<typeof activeContext.newPage>> | undefined

  try {
    page = await activeContext.newPage()

    // addCookies replaces cookies by name+domain+path, so no need to clearCookies first.
    // Keeping the context's CF cookies (cf_clearance, __cf_bm) intact means CF sees a
    // browser with history, which speeds up challenge evaluation on the next Tier 3 run.
    await activeContext.addCookies(
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

    const mainResponse = trackMainDocumentResponses(page)

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

    if (isCloudflarePage(html, mainResponse.headers)) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: "session-expired" }
    }

    // A cached session that lands back on Akamai's interstitial is stale — force a
    // fresh Tier-3 solve rather than returning the ~2KB challenge stub as content.
    if (hasAkamaiChallenge(html)) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: "akamai-session-expired" }
    }

    // Same reasoning for DataDome: isBlocked() already catches the 403, but a stale
    // `datadome` cookie is worth telling apart from any other 403 in the logs.
    if (hasDataDomeChallenge(html)) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: "datadome-session-expired" }
    }

    if (isBlocked(mainResponse.status, html)) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: `http-${mainResponse.status}` }
    }

    // Attempt to solve any embedded captcha widgets (Turnstile, reCAPTCHA, hCaptcha).
    // Pages that load cleanly via session cache may still have in-page challenge widgets.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = []
    if (solveRemaining > 5000) {
      const result = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = result.solved
    }

    const finalHtml = await page.content()
    if (isCloudflarePage(finalHtml, mainResponse.headers)) {
      return { tier: 2, status: "blocked", durationMs: Date.now() - start, reason: "session-expired" }
    }

    const cookies: Cookie[] = toCookies(await activeContext.cookies())

    const captured = await captureResponse(mainResponse.response)

    return {
      tier: 2,
      status: "success",
      durationMs: Date.now() - start,
      effectiveUrl: page.url(),
      // For HTML/text content-types, `html` is the rendered DOM. For binary, leave
      // empty so /scrape consumers know to use `body`/`contentType`.
      html: !captured.contentType || isTextContentType(captured.contentType) ? normalizeHtml(finalHtml) : "",
      ...captured,
      cookies,
      statusCode: mainResponse.status,
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
    await page?.close().catch(() => {})
  }
}
