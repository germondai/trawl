import type { BrowserHandle } from "@trawl/browser"
import { FINGERPRINT, newFreshContext } from "@trawl/browser"
import type { Cookie, TierResult } from "@trawl/types"
import { waitForChallengeResolution } from "./challengeWait"
import { detectChallengeType, hasImpervaChallenge, isBlocked, isBrowserErrorPage, isCloudflarePage } from "./detect"
import { normalizeHtml } from "./html"
import { waitForImpervaResolution } from "./impervaWait"
import type { RouteLike } from "./sanitize"
import { routeContinueOverrides } from "./sanitize"
import { solvePageCaptchas } from "./solvers"

export interface Tier3Result extends TierResult {
  tier: 3
  html?: string
  cookies?: Cookie[]
  userAgent?: string
  statusCode?: number
  captchasSolved?: string[]
}

export async function runTier3(
  url: string,
  handle: BrowserHandle,
  maxTimeout: number,
  proxyUrl?: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
): Promise<Tier3Result> {
  const start = Date.now()

  // CRITICAL: Use a fresh browser context for CF challenge solving.
  // A warm/reused context carries accumulated state (localStorage, service workers, JS
  // engine state) that CF's behavioral analysis scores as suspicious — resulting in 40s
  // challenge evaluation. A fresh context with no prior state gets managed-mode treatment:
  // CF evaluates in under 1s and the challenge resolves in 3-4s total.
  const freshCtx = await newFreshContext(handle.browser, { proxy: proxyUrl })
  const page = await freshCtx.newPage()

  try {
    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    let statusCode = 200
    page.on("response", (res: { url(): string; status(): number }) => {
      try {
        const resUrl = res.url()
        if (resUrl === url || resUrl.startsWith(url.replace(/\/$/, ""))) {
          statusCode = res.status()
        }
      } catch {}
    })

    // CF challenges can trigger sub-navigations that throw "navigation interrupted" —
    // we catch those so we can continue. Hard failures (DNS, connection refused) are
    // rethrown so they surface as proper errors.
    const gotoErr = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(maxTimeout, 30_000),
      })
      .catch((e: Error) => e)

    // Abort early on hard network failures — no point running challenge wait
    if (gotoErr instanceof Error) {
      const msg = gotoErr.message
      const isHardFail =
        /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/i.test(
          msg,
        )
      if (isHardFail) {
        return { tier: 3, status: "error", durationMs: Date.now() - start, reason: msg.split("\n")[0] }
      }
      // Otherwise (navigation interrupted by CF redirect) — fall through and keep going
    }

    const remaining = maxTimeout - (Date.now() - start)
    const peekHtml = await page.content().catch(() => "")
    const challengeType = detectChallengeType(peekHtml)
    const resolution =
      challengeType === "imperva"
        ? await waitForImpervaResolution(page, remaining, url)
        : await waitForChallengeResolution(page, remaining, url)

    if (resolution !== "ok") {
      return {
        tier: 3,
        status: resolution === "ip-blocked" ? "blocked" : "timeout",
        durationMs: Date.now() - start,
        reason:
          resolution === "ip-blocked"
            ? challengeType === "imperva"
              ? "datacenter-ip-blocked (imperva sensor cookie obtained but challenge persisted — needs residential proxy)"
              : "datacenter-ip-blocked (cf_clearance obtained but redirect never completed — needs residential proxy)"
            : challengeType === "imperva"
              ? "imperva-challenge-timeout"
              : "cloudflare-challenge-timeout",
      }
    }

    // challengeWait calls waitForLoadState('load') but the CF interstitial iframe can
    // linger in page.frames() briefly after navigation. Give it 600ms to clear so the
    // captcha solver doesn't mistake the just-solved interstitial for an in-page widget.
    await new Promise((r) => setTimeout(r, 600))

    // Attempt to solve any embedded captcha widgets on the page (Turnstile, reCaptcha, hCaptcha).
    // This handles sites where the page itself loads fine but has an in-page challenge widget.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = []
    if (solveRemaining > 5000) {
      const solveResult = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = solveResult.solved
    }

    const html = await page.content()

    // Empty shell means the browser got nothing — treat as a load failure
    if (html.length < 100) {
      const errMsg = gotoErr instanceof Error ? gotoErr.message.split("\n")[0] : "page returned empty content"
      return { tier: 3, status: "error", durationMs: Date.now() - start, reason: errMsg }
    }

    // Browser never reached a real server (DNS/connection/TLS failure) — the "navigation
    // interrupted" tolerance above lets Firefox-specific network errors fall through
    // instead of hitting the isHardFail regex (which only matches Chromium ERR_* strings),
    // so we still need to catch the resulting about:neterror page here.
    if (isBrowserErrorPage(html)) {
      const errMsg = gotoErr instanceof Error ? gotoErr.message.split("\n")[0] : "browser network error (about:neterror)"
      return { tier: 3, status: "error", durationMs: Date.now() - start, reason: errMsg }
    }

    if (isCloudflarePage(html, {})) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] cloudflare-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "cloudflare-persistent" }
    }

    if (hasImpervaChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] imperva-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "imperva-persistent" }
    }

    if (isBlocked(statusCode, html)) {
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: `http-${statusCode}` }
    }

    const rawCookies = await freshCtx.cookies()
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
      tier: 3,
      status: "success",
      durationMs: Date.now() - start,
      html: normalizeHtml(html),
      cookies,
      userAgent: await page.evaluate(() => navigator.userAgent).catch(() => FINGERPRINT.userAgent),
      statusCode,
      captchasSolved: captchasSolved.length > 0 ? captchasSolved : undefined,
    }
  } catch (err) {
    return {
      tier: 3,
      status: "error",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await page.close().catch(() => {})
    // Bound context.close() with a timeout — Camoufox/Firefox occasionally hangs on
    // close when a content process is wedged, leaking the process until the next
    // browser recycle. 5s is well above the typical <500ms close path.
    await Promise.race([freshCtx.close(), new Promise<void>((resolve) => setTimeout(resolve, 5000))]).catch(() => {})
  }
}
