import type { BrowserHandle } from "@trawl/browser"
import { closeTemporaryContext, FINGERPRINT, newFreshContext } from "@trawl/browser"
import type {
  CapturedResponseEntry,
  ConsoleLogEntry,
  Cookie,
  FaviconEntry,
  NetworkLogEntry,
  TierResult,
} from "@trawl/types"
import { capturePageFavicons } from "../favicons"
import { capturePageScreenshot } from "../screenshot"
import { solvePageCaptchas } from "../solvers"
import { reportBlocked } from "../utils/blockedEvidence"
import { attachPageCapture, type CaptureOptions } from "../utils/capture"
import { routeChallengeWait } from "../utils/challengeRouter"
import { snapshotChallengeCookies, toCookies } from "../utils/cookies"
import {
  hasAkamaiChallenge,
  hasDataDomeChallenge,
  hasDdosGuardChallenge,
  hasDuckDuckGoChallenge,
  hasImpervaChallenge,
  isBlocked,
  isBrowserErrorPage,
  isCloudflarePage,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import { trackMainDocumentResponses } from "../utils/mainResponse"
import { isHardNetworkFailure } from "../utils/network"
import { installOutboundPolicy, type OutboundUrlValidator } from "../utils/outboundPolicy"
import { isProxyTransportFailure, normalizeProxyError, proxyResponseFailure } from "../utils/proxyFailure"
import { captureResponse, isHtmlContentType, isTextContentType } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"

export interface Tier4Result extends TierResult {
  tier: 4
  challenge?: "datadome"
  effectiveUrl?: string
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  cookies?: Cookie[]
  userAgent?: string
  statusCode?: number
  captchasSolved?: string[]
  screenshot?: string
  favicons?: FaviconEntry[]
  consoleLogs?: ConsoleLogEntry[]
  networkLogs?: NetworkLogEntry[]
  redirectChain?: string[]
  capturedResponses?: CapturedResponseEntry[]
  mhtml?: string
}

export async function runTier4(
  url: string,
  handle: BrowserHandle,
  maxTimeout: number,
  proxyUrl: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  validateOutboundUrl?: OutboundUrlValidator,
  screenshot?: boolean,
  capture: CaptureOptions = {},
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
    await installOutboundPolicy(page, validateOutboundUrl)
    const initialCookies = snapshotChallengeCookies(await proxyContext.cookies())

    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    const pageCapture = attachPageCapture(page, capture)
    const mainResponse = trackMainDocumentResponses(page, { redirectChain: capture.redirectChain })

    const gotoErr = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(maxTimeout, 30_000),
      })
      .catch((e: Error) => e)

    if (isHardNetworkFailure(gotoErr)) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: normalizeProxyError(gotoErr) }
    }
    const earlyProxyFailure = proxyResponseFailure(mainResponse.status, mainResponse.headers)
    if (earlyProxyFailure) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: earlyProxyFailure }
    }

    const remaining = maxTimeout - (Date.now() - start)
    const peekHtml = await page.content().catch(() => "")
    const { challengeType, resolution } = await routeChallengeWait(
      page,
      peekHtml,
      mainResponse.headers,
      remaining,
      url,
      undefined,
      mainResponse.status,
      initialCookies,
    )

    if (resolution !== "ok") {
      const status = resolution === "ip-blocked" || resolution === "captcha-required" ? "blocked" : "timeout"
      const reason =
        resolution === "captcha-required"
          ? `${challengeType}-captcha-required`
          : resolution === "ip-blocked"
            ? "proxy-ip-blocked"
            : `${challengeType === "none" ? "cloudflare" : challengeType}-challenge-timeout`
      await reportBlocked(
        page,
        capture.blockedEvidence,
        { tier: 4, status, reason, statusCode: mainResponse.status, html: peekHtml },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 4, status, durationMs: Date.now() - start, reason }
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})

    // Attempt to solve any embedded captcha widgets on the page (Turnstile, reCaptcha, hCaptcha) —
    // same as Tier 3. Sites that reach Tier 4 for IP reputation can still have an in-page widget.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = []
    if (solveRemaining > 5000) {
      const solveResult = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = solveResult.solved
    }

    // Hold the page open for the capture's settle window before reading anything, so a
    // late XHR the caller is chasing lands in the same evidence as the markup.
    await pageCapture.settle(maxTimeout - (Date.now() - start))

    // Shot before the html read so the image and the returned html describe the same
    // moment — the settle wait inside the capture can outlast a slow-clearing challenge.
    const shot = screenshot ? await capturePageScreenshot(page, maxTimeout - (Date.now() - start)) : undefined
    const evidence = await pageCapture.drain(maxTimeout - (Date.now() - start))

    const html = await page.content()

    if (html.length < 100) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: "page returned empty content" }
    }

    if (isBrowserErrorPage(html)) {
      return {
        tier: 4,
        status: "error",
        durationMs: Date.now() - start,
        reason: "proxy-connection-failed",
      }
    }

    if (isCloudflarePage(html, mainResponse.headers)) {
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 4,
          status: "blocked",
          reason: "cloudflare-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "cloudflare-persistent",
      }
    }

    if (hasImpervaChallenge(html)) {
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 4,
          status: "blocked",
          reason: "imperva-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "imperva-persistent",
      }
    }

    if (hasAkamaiChallenge(html)) {
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 4,
          status: "blocked",
          reason: "akamai-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "akamai-persistent",
      }
    }

    if (hasDdosGuardChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier4] ddos-guard-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 4,
          status: "blocked",
          reason: "ddos-guard-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 4, status: "blocked", durationMs: Date.now() - start, reason: "ddos-guard-persistent" }
    }

    if (hasDataDomeChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier4] datadome-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 4,
          status: "blocked",
          reason: "datadome-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "datadome-persistent",
        challenge: "datadome",
      }
    }

    if (hasDuckDuckGoChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier4] duckduckgo-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 4,
          status: "blocked",
          reason: "duckduckgo-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "duckduckgo-persistent",
      }
    }

    if (isBlocked(mainResponse.status, html)) {
      const reason = `http-${mainResponse.status}`
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 4,
          status: "blocked",
          reason,
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 4, status: "blocked", durationMs: Date.now() - start, reason }
    }

    // After the capture is drained, so these fetches never land in the captured
    // responses, the network log or the MHTML archive.
    const icons = capture.favicons ? await capturePageFavicons(page, maxTimeout - (Date.now() - start)) : undefined

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
      screenshot: shot,
      favicons: icons,
      ...evidence,
      redirectChain: capture.redirectChain ? mainResponse.redirectChain : undefined,
      mhtml: isHtmlContentType(captured.contentType) ? pageCapture.archive(page.url(), html) : undefined,
    }
  } catch (err) {
    return {
      tier: 4,
      status: "error",
      durationMs: Date.now() - start,
      reason: isProxyTransportFailure(err)
        ? normalizeProxyError(err)
        : err instanceof Error
          ? err.message
          : String(err),
    }
  } finally {
    await closeTemporaryContext(state.proxyContext, handle.requestBrowserReplacement, "tier4 context cleanup timed out")
  }
}
