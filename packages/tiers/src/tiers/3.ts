import type { BrowserHandle } from "@trawl/browser"
import { closeTemporaryContext, FINGERPRINT, newFreshContext } from "@trawl/browser"
import type { Cookie, TierResult } from "@trawl/types"
import { solvePageCaptchas } from "../solvers"
import { waitForAkamaiResolution } from "../utils/akamaiWait"
import { waitForAwsWafResolution } from "../utils/awsWafWait"
import { waitForChallengeResolution } from "../utils/challengeWait"
import { toCookies } from "../utils/cookies"
import {
  detectChallengeType,
  hasAkamaiChallenge,
  hasAwsWafInterstitial,
  hasImpervaChallenge,
  isBlocked,
  isBrowserErrorPage,
  isCloudflarePage,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import { waitForImpervaResolution } from "../utils/impervaWait"
import { trackMainDocumentResponses } from "../utils/mainResponse"
import { isHardNetworkFailure } from "../utils/network"
import { captureResponse, isTextContentType } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"

export interface Tier3Result extends TierResult {
  tier: 3
  effectiveUrl?: string
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
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
  let freshCtx: Awaited<ReturnType<typeof newFreshContext>> | undefined

  try {
    freshCtx = await newFreshContext(handle.browser, {
      proxy: proxyUrl,
      onCreated: handle.noteTemporaryContext,
      requestReplacement: handle.requestBrowserReplacement,
    })
    const page = await freshCtx.newPage()
    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    const mainResponse = trackMainDocumentResponses(page)

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
    if (isHardNetworkFailure(gotoErr)) {
      return { tier: 3, status: "error", durationMs: Date.now() - start, reason: gotoErr.message.split("\n")[0] }
    }
    // Otherwise (navigation interrupted by CF redirect) — fall through and keep going

    const remaining = maxTimeout - (Date.now() - start)
    const peekHtml = await page.content().catch(() => "")
    const challengeType = detectChallengeType(peekHtml, mainResponse.headers)
    let captchasSolved: string[] = []
    let resolution: "ok" | "ip-blocked" | "timeout"
    if (challengeType === "aws-waf") {
      const awsResolution = await waitForAwsWafResolution(page, remaining, url, () => mainResponse.headers)
      resolution = awsResolution.status
      if (awsResolution.captchaSolved) captchasSolved.push("aws-waf")
    } else {
      resolution =
        challengeType === "imperva"
          ? await waitForImpervaResolution(page, remaining, url)
          : challengeType === "akamai"
            ? await waitForAkamaiResolution(page, remaining, url)
            : await waitForChallengeResolution(page, remaining, url, () => mainResponse.headers)
    }

    if (resolution !== "ok") {
      return {
        tier: 3,
        status: resolution === "ip-blocked" ? "blocked" : "timeout",
        durationMs: Date.now() - start,
        reason:
          resolution === "ip-blocked"
            ? challengeType === "imperva"
              ? "datacenter-ip-blocked (imperva sensor cookie obtained but challenge persisted — needs residential proxy)"
              : challengeType === "akamai"
                ? "datacenter-ip-blocked (Akamai sensor cookie obtained but challenge persisted — needs residential proxy)"
                : "datacenter-ip-blocked (cf_clearance obtained but redirect never completed — needs residential proxy)"
            : `${challengeType === "none" ? "cloudflare" : challengeType}-challenge-timeout`,
      }
    }

    // challengeWait calls waitForLoadState('load') but the CF interstitial iframe can
    // linger in page.frames() briefly after navigation. Give it 600ms to clear so the
    // captcha solver doesn't mistake the just-solved interstitial for an in-page widget.
    await new Promise((r) => setTimeout(r, 600))

    // Attempt to solve any embedded captcha widgets on the page (AWS WAF, Turnstile, reCaptcha, hCaptcha).
    // This handles sites where the page itself loads fine but has an in-page challenge widget.
    const solveRemaining = maxTimeout - (Date.now() - start)
    if (solveRemaining > 5000) {
      const solveResult = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = [...new Set([...captchasSolved, ...solveResult.solved])]
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
      const errMsg =
        gotoErr instanceof Error ? gotoErr.message.split("\n")[0] : "browser network error (about:neterror)"
      return { tier: 3, status: "error", durationMs: Date.now() - start, reason: errMsg }
    }

    if (isCloudflarePage(html, mainResponse.headers)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] cloudflare-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "cloudflare-persistent" }
    }

    if (hasAwsWafInterstitial(html, mainResponse.headers)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] aws-waf-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "aws-waf-persistent" }
    }

    if (hasImpervaChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] imperva-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "imperva-persistent" }
    }

    if (hasAkamaiChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] akamai-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "akamai-persistent" }
    }

    if (isBlocked(mainResponse.status, html, mainResponse.headers)) {
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: `http-${mainResponse.status}` }
    }

    const cookies: Cookie[] = toCookies(await freshCtx.cookies())

    const captured = await captureResponse(mainResponse.response)

    return {
      tier: 3,
      status: "success",
      durationMs: Date.now() - start,
      effectiveUrl: page.url(),
      html: !captured.contentType || isTextContentType(captured.contentType) ? normalizeHtml(html) : "",
      ...captured,
      cookies,
      userAgent: await page.evaluate(() => navigator.userAgent).catch(() => FINGERPRINT.userAgent),
      statusCode: mainResponse.status,
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
    // Closing the context closes all of its pages. If Firefox wedges during cleanup,
    // ask the pool to replace this browser as soon as the lease is released.
    await closeTemporaryContext(freshCtx, handle.requestBrowserReplacement, "tier3 context cleanup timed out")
  }
}
