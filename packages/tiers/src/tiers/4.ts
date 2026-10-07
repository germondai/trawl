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
import { hasAnubisDestinationContent, isAnubisVerificationUrl } from "../utils/anubis"
import { reportBlocked } from "../utils/blockedEvidence"
import { attachPageCapture, type CaptureOptions } from "../utils/capture"
import { routeChallengeWait } from "../utils/challengeRouter"
import { snapshotChallengeCookies, toCookies } from "../utils/cookies"
import { DeadlineError, RequestBudget } from "../utils/deadline"
import {
  hasAkamaiChallenge,
  hasAnubisChallenge,
  hasDataDomeChallenge,
  hasDdosGuardChallenge,
  hasDuckDuckGoChallenge,
  hasImpervaChallenge,
  isBlocked,
  isBrowserErrorPage,
  isCloudflarePage,
} from "../utils/detect"
import { isGoogleSorryUrl } from "../utils/googleSorry"
import { trackMainDocumentResponses } from "../utils/mainResponse"
import { followMetaRefresh } from "../utils/metaRefresh"
import { isHardNetworkFailure } from "../utils/network"
import { installOutboundPolicy, type OutboundUrlValidator } from "../utils/outboundPolicy"
import { isProxyTransportFailure, normalizeProxyError, proxyResponseFailure } from "../utils/proxyFailure"
import { browserDocumentHtml, captureResponse, isHtmlContentType, isNonHtmlTextContentType } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"
import { waitForVisibleSelector } from "../utils/waitForVisibleSelector"

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

async function runTier4Task(
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
  ignoreCertificateErrors?: boolean,
): Promise<Tier4Result> {
  const start = Date.now()

  // Create an isolated context routed through the proxy.
  // Proxies must be set at context creation time in Playwright — they cannot be
  // applied per-request. We create a fresh context here and close it when done,
  // leaving the pool's shared context untouched.
  const state: { proxyContext?: Awaited<ReturnType<typeof newFreshContext>> } = {}
  let openingContext: ReturnType<typeof newFreshContext> | undefined

  const budget = capture.budget
  if (!budget) throw new Error("Browser task requires an operation budget")
  let cleanup: Promise<void> | undefined
  const close = () =>
    (cleanup ??= closeTemporaryContext(
      openingContext ?? state.proxyContext,
      handle.requestBrowserReplacement,
      "tier4 context cleanup timed out",
    ))
  let disown = () => {}
  try {
    openingContext = newFreshContext(handle.browser, {
      proxy: proxyUrl,
      onCreated: handle.noteTemporaryContext,
      requestReplacement: handle.requestBrowserReplacement,
      ignoreHttpsErrors: ignoreCertificateErrors,
    })
    disown = budget.own(close)
    const proxyContext = await openingContext
    state.proxyContext = proxyContext
    budget.check()

    const page = await proxyContext.newPage()
    budget.check()
    page.setDefaultTimeout?.(Math.max(1, budget.remaining()))
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

    const anubisRefresh = capture.followMetaRefresh && hasAnubisChallenge(await page.content().catch(() => ""))
    const refresh =
      capture.followMetaRefresh && !anubisRefresh
        ? await followMetaRefresh(page, maxTimeout - (Date.now() - start), validateOutboundUrl)
        : undefined
    if (refresh && refresh.status !== "ok") {
      return { tier: 4, status: refresh.status, durationMs: Date.now() - start, reason: refresh.reason }
    }

    const remaining = maxTimeout - (Date.now() - start)
    const peekHtml = await page.content().catch(() => "")
    const {
      challengeType,
      resolution,
      captchasSolved: wallCaptchas,
    } = await routeChallengeWait(
      page,
      peekHtml,
      mainResponse.headers,
      remaining,
      refresh?.url ?? url,
      undefined,
      mainResponse.status,
      initialCookies,
      () => mainResponse.headers,
      capture.externalCaptcha,
      proxyUrl,
      budget.signal,
    )

    if (resolution === "browser-closed") {
      return { tier: 4, status: "error", reason: "anubis-browser-closed", durationMs: Date.now() - start }
    }

    if (resolution !== "ok") {
      const status =
        resolution === "blocked" || resolution === "ip-blocked" || resolution === "captcha-required"
          ? "blocked"
          : "timeout"
      const reason =
        resolution === "blocked"
          ? "anubis-blocked"
          : resolution === "captcha-required"
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

    if (anubisRefresh) {
      const destination = await followMetaRefresh(page, maxTimeout - (Date.now() - start), validateOutboundUrl)
      if (destination.status !== "ok") {
        return { tier: 4, status: destination.status, durationMs: Date.now() - start, reason: destination.reason }
      }
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})

    // Attempt to solve any embedded captcha widgets on the page (Turnstile, reCaptcha, hCaptcha) —
    // same as Tier 3. Sites that reach Tier 4 for IP reputation can still have an in-page widget.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = wallCaptchas ?? []
    if (solveRemaining > 5000) {
      const solveResult = await solvePageCaptchas(
        page,
        solveRemaining,
        budget.signal,
        capture.externalCaptcha,
        proxyUrl,
      ).catch(() => ({
        attempted: [],
        solved: [],
      }))
      captchasSolved = [...new Set([...captchasSolved, ...solveResult.solved])]
    }

    // Hold the page open for the capture's settle window before reading anything, so a
    // late XHR the caller is chasing lands in the same evidence as the markup.
    await pageCapture.settle(maxTimeout - (Date.now() - start))
    if (capture.contentWaitForSelector) {
      await waitForVisibleSelector(page, capture.contentWaitForSelector, maxTimeout - (Date.now() - start))
    }

    // Shot before the html read so the image and the returned html describe the same
    // moment — the settle wait inside the capture can outlast a slow-clearing challenge.
    const shot = screenshot
      ? await capturePageScreenshot(page, maxTimeout - (Date.now() - start), {
          fullPage: capture.screenshotFullPage,
          waitForSelector: capture.screenshotWaitForSelector,
          selector: capture.screenshotSelector,
        })
      : undefined
    const evidence = await pageCapture.drain(maxTimeout - (Date.now() - start))

    const html = await page.content()

    if (
      hasAnubisChallenge(html) ||
      isAnubisVerificationUrl(page.url()) ||
      (challengeType === "anubis" && (mainResponse.status >= 400 || !hasAnubisDestinationContent(html)))
    ) {
      const reason = "anubis-persistent"
      await reportBlocked(
        page,
        capture.blockedEvidence,
        { tier: 4, status: "blocked", reason, statusCode: mainResponse.status, html, screenshot: shot },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 4, status: "blocked", durationMs: Date.now() - start, reason }
    }

    if (isGoogleSorryUrl(page.url())) {
      const reason = "google-sorry-persistent"
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

    if (
      html.length < 100 &&
      challengeType !== "anubis" &&
      !isNonHtmlTextContentType(mainResponse.headers["content-type"])
    ) {
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
      html: browserDocumentHtml(captured.contentType, html, captured.body),
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
    await close()
    disown()
  }
}

export async function runTier4(...args: Parameters<typeof runTier4Task>): Promise<Tier4Result> {
  const started = Date.now()
  const capture = args[9] ?? {}
  const budget = capture.budget ?? new RequestBudget(args[2])
  args[9] = { ...capture, budget }
  try {
    return await budget.run(() => runTier4Task(...args))
  } catch (error) {
    if (error instanceof DeadlineError)
      return { tier: 4, status: "timeout", reason: error.message, durationMs: Date.now() - started }
    throw error
  } finally {
    if (!capture.budget) budget.dispose()
  }
}
