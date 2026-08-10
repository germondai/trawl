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

export interface Tier4Result extends TierResult {
  tier: 4
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

export async function runTier4(
  url: string,
  handle: BrowserHandle,
  maxTimeout: number,
  proxyUrl: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
): Promise<Tier4Result> {
  const start = Date.now()

  // Create an isolated context routed through the proxy.
  // Proxies must be set at context creation time in Playwright — they cannot be
  // applied per-request. We create a fresh context here and close it when done,
  // leaving the pool's shared context untouched.
  const state: { proxyContext?: Awaited<ReturnType<typeof newFreshContext>> } = {}

  try {
    const proxyContext = await newFreshContext(handle.browser, {
      proxy: proxyUrl,
      onCreated: handle.noteTemporaryContext,
      requestReplacement: handle.requestBrowserReplacement,
    })
    state.proxyContext = proxyContext

    const page = await proxyContext.newPage()

    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    const mainResponse = trackMainDocumentResponses(page)

    const gotoErr = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(maxTimeout, 30_000),
      })
      .catch((e: Error) => e)

    if (isHardNetworkFailure(gotoErr)) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: gotoErr.message.split("\n")[0] }
    }

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
        tier: 4,
        status: resolution === "ip-blocked" ? "blocked" : "timeout",
        durationMs: Date.now() - start,
        reason:
          resolution === "ip-blocked"
            ? "proxy-ip-blocked"
            : `${challengeType === "none" ? "cloudflare" : challengeType}-challenge-timeout`,
      }
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})

    // Attempt to solve any embedded captcha widgets on the page (AWS WAF, Turnstile, reCaptcha, hCaptcha) —
    // same as Tier 3. Sites that reach Tier 4 for IP reputation can still have an in-page widget.
    const solveRemaining = maxTimeout - (Date.now() - start)
    if (solveRemaining > 5000) {
      const solveResult = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = [...new Set([...captchasSolved, ...solveResult.solved])]
    }

    const html = await page.content()

    if (html.length < 100) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: "page returned empty content" }
    }

    if (isBrowserErrorPage(html)) {
      return {
        tier: 4,
        status: "error",
        durationMs: Date.now() - start,
        reason: "browser network error (about:neterror)",
      }
    }

    if (isCloudflarePage(html, mainResponse.headers)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "cloudflare-persistent",
      }
    }

    if (hasAwsWafInterstitial(html, mainResponse.headers)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "aws-waf-persistent",
      }
    }

    if (hasImpervaChallenge(html)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "imperva-persistent",
      }
    }

    if (hasAkamaiChallenge(html)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "akamai-persistent",
      }
    }

    if (isBlocked(mainResponse.status, html, mainResponse.headers)) {
      return { tier: 4, status: "blocked", durationMs: Date.now() - start, reason: `http-${mainResponse.status}` }
    }

    const cookies: Cookie[] = toCookies(await proxyContext.cookies())

    const captured = await captureResponse(mainResponse.response)

    return {
      tier: 4,
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
      tier: 4,
      status: "error",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await closeTemporaryContext(state.proxyContext, handle.requestBrowserReplacement, "tier4 context cleanup timed out")
  }
}
