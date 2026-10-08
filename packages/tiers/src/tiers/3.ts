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
import { normalizeInputCookies, snapshotChallengeCookies, toCookies } from "../utils/cookies"
import { DeadlineError, RequestBudget } from "../utils/deadline"
import {
  type ChallengeType,
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
import { restoreSessionStorage } from "../utils/sessionStorage"
import { waitForVisibleSelector } from "../utils/waitForVisibleSelector"

// Why a wall survived its waiter on a datacenter IP. The clearance token was obtained in
// every one of these cases, so what is left is the egress IP, not the challenge logic.
const DATACENTER_BLOCKED_REASONS: Partial<Record<ChallengeType, string>> = {
  imperva: "datacenter-ip-blocked (imperva sensor cookie obtained but challenge persisted — needs residential proxy)",
  akamai: "datacenter-ip-blocked (Akamai sensor cookie obtained but challenge persisted — needs residential proxy)",
  "ddos-guard":
    "datacenter-ip-blocked (DDoS-Guard clearance cookie obtained but challenge persisted — needs residential proxy)",
  "aws-waf": "datacenter-ip-blocked (AWS WAF token obtained but challenge persisted — needs residential proxy)",
  datadome:
    "datadome-persistent (a datadome cookie was issued but the wall held — check BROWSER_HEADFUL_POOL_SIZE, then try a residential proxy)",
}

const DEFAULT_DATACENTER_BLOCKED_REASON =
  "datacenter-ip-blocked (cf_clearance obtained but redirect never completed — needs residential proxy)"

export interface Tier3Result extends TierResult {
  tier: 3
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

async function runTier3Task(
  url: string,
  handle: BrowserHandle,
  maxTimeout: number,
  proxyUrl?: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  validateOutboundUrl?: OutboundUrlValidator,
  screenshot?: boolean,
  capture: CaptureOptions = {},
  ignoreCertificateErrors?: boolean,
): Promise<Tier3Result> {
  const start = Date.now()

  // Ordinary challenge solves use a fresh context. Named sessions explicitly
  // retain their context because login state must survive subsequent requests.
  // A warm/reused context carries accumulated state (localStorage, service workers, JS
  // engine state) that CF's behavioral analysis scores as suspicious — resulting in 40s
  // challenge evaluation. A fresh context with no prior state gets managed-mode treatment:
  // CF evaluates in under 1s and the challenge resolves in 3-4s total.
  let freshCtx: Awaited<ReturnType<typeof newFreshContext>> | undefined
  let openingContext: ReturnType<typeof newFreshContext> | undefined

  const budget = capture.budget
  if (!budget) throw new Error("Browser task requires an operation budget")
  let cleanup: Promise<void> | undefined
  const close = () =>
    (cleanup ??= closeTemporaryContext(
      capture.sessionContext ? undefined : (openingContext ?? freshCtx),
      handle.requestBrowserReplacement,
      "tier3 context cleanup timed out",
    ))
  let disown = () => {}
  try {
    openingContext = capture.sessionContext
      ? Promise.resolve(capture.sessionContext)
      : newFreshContext(handle.browser, {
          proxy: proxyUrl,
          onCreated: handle.noteTemporaryContext,
          requestReplacement: handle.requestBrowserReplacement,
          ignoreHttpsErrors: ignoreCertificateErrors,
        })
    disown = budget.own(close)
    freshCtx = await openingContext
    budget.check()
    if (capture.cookies?.length) {
      await freshCtx.clearCookies()
      await freshCtx.addCookies(normalizeInputCookies(capture.cookies, url))
    }
    const page = await freshCtx.newPage()
    const storageRestore = capture.sessionStorage?.size
      ? await restoreSessionStorage(page, capture.sessionStorage)
      : undefined
    budget.check()
    page.setDefaultTimeout?.(Math.max(1, budget.remaining()))
    await installOutboundPolicy(page, validateOutboundUrl)
    const initialCookies = snapshotChallengeCookies(await freshCtx.cookies())
    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    const pageCapture = attachPageCapture(page, capture)
    const mainResponse = trackMainDocumentResponses(page, { redirectChain: capture.redirectChain })

    // CF challenges can trigger sub-navigations that throw "navigation interrupted" —
    // we catch those so we can continue. Hard failures (DNS, connection refused) are
    // rethrown so they surface as proper errors.
    const gotoErr = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(maxTimeout, 30_000),
      })
      .catch((e: Error) => e)
    await storageRestore?.dispose()

    // Abort early on hard network failures — no point running challenge wait
    if (isHardNetworkFailure(gotoErr)) {
      return {
        tier: 3,
        status: "error",
        durationMs: Date.now() - start,
        reason:
          proxyUrl && isProxyTransportFailure(gotoErr) ? normalizeProxyError(gotoErr) : gotoErr.message.split("\n")[0],
      }
    }
    const earlyProxyFailure = proxyUrl ? proxyResponseFailure(mainResponse.status, mainResponse.headers) : undefined
    if (earlyProxyFailure) {
      return { tier: 3, status: "error", durationMs: Date.now() - start, reason: earlyProxyFailure }
    }
    // Otherwise (navigation interrupted by CF redirect) — fall through and keep going

    const anubisRefresh = capture.followMetaRefresh && hasAnubisChallenge(await page.content().catch(() => ""))
    const refresh =
      capture.followMetaRefresh && !anubisRefresh
        ? await followMetaRefresh(page, maxTimeout - (Date.now() - start), validateOutboundUrl)
        : undefined
    if (refresh && refresh.status !== "ok") {
      return { tier: 3, status: refresh.status, durationMs: Date.now() - start, reason: refresh.reason }
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
      return { tier: 3, status: "error", reason: "anubis-browser-closed", durationMs: Date.now() - start }
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
              ? (DATACENTER_BLOCKED_REASONS[challengeType] ?? DEFAULT_DATACENTER_BLOCKED_REASON)
              : `${challengeType === "none" ? "cloudflare" : challengeType}-challenge-timeout`
      await reportBlocked(
        page,
        capture.blockedEvidence,
        { tier: 3, status, reason, statusCode: mainResponse.status, html: peekHtml },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status, durationMs: Date.now() - start, reason }
    }

    if (anubisRefresh) {
      const destination = await followMetaRefresh(page, maxTimeout - (Date.now() - start), validateOutboundUrl)
      if (destination.status !== "ok") {
        return { tier: 3, status: destination.status, durationMs: Date.now() - start, reason: destination.reason }
      }
    }

    // challengeWait calls waitForLoadState('load') but the CF interstitial iframe can
    // linger in page.frames() briefly after navigation. Give it 600ms to clear so the
    // captcha solver doesn't mistake the just-solved interstitial for an in-page widget.
    if (challengeType !== "anubis") await new Promise((r) => setTimeout(r, 600))

    // Attempt to solve any embedded captcha widgets on the page (Turnstile, reCaptcha, hCaptcha).
    // This handles sites where the page itself loads fine but has an in-page challenge widget.
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
        { tier: 3, status: "blocked", reason, statusCode: mainResponse.status, html, screenshot: shot },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason }
    }

    if (isGoogleSorryUrl(page.url())) {
      const reason = "google-sorry-persistent"
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason,
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason }
    }

    // Empty shell means the browser got nothing — treat as a load failure
    if (
      html.length < 100 &&
      challengeType !== "anubis" &&
      !isNonHtmlTextContentType(mainResponse.headers["content-type"])
    ) {
      const errMsg = gotoErr instanceof Error ? gotoErr.message.split("\n")[0] : "page returned empty content"
      return { tier: 3, status: "error", durationMs: Date.now() - start, reason: errMsg }
    }

    // Browser never reached a real server (DNS/connection/TLS failure) — the "navigation
    // interrupted" tolerance above lets Firefox-specific network errors fall through
    // instead of hitting the isHardFail regex (which only matches Chromium ERR_* strings),
    // so we still need to catch the resulting about:neterror page here.
    if (isBrowserErrorPage(html)) {
      const errMsg = proxyUrl
        ? "proxy-connection-failed"
        : gotoErr instanceof Error
          ? gotoErr.message.split("\n")[0]
          : "browser network error (about:neterror)"
      return { tier: 3, status: "error", durationMs: Date.now() - start, reason: errMsg }
    }

    if (isCloudflarePage(html, mainResponse.headers)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] cloudflare-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason: "cloudflare-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "cloudflare-persistent" }
    }

    if (hasImpervaChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] imperva-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason: "imperva-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "imperva-persistent" }
    }

    if (hasAkamaiChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] akamai-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason: "akamai-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "akamai-persistent" }
    }

    if (hasDdosGuardChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] ddos-guard-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason: "ddos-guard-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "ddos-guard-persistent" }
    }

    if (hasDataDomeChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] datadome-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason: "datadome-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return {
        tier: 3,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "datadome-persistent",
        challenge: "datadome",
      }
    }

    if (hasDuckDuckGoChallenge(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier3] duckduckgo-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason: "duckduckgo-persistent",
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason: "duckduckgo-persistent" }
    }

    if (isBlocked(mainResponse.status, html)) {
      const reason = `http-${mainResponse.status}`
      await reportBlocked(
        page,
        capture.blockedEvidence,
        {
          tier: 3,
          status: "blocked",
          reason,
          statusCode: mainResponse.status,
          html,
          screenshot: shot,
        },
        maxTimeout - (Date.now() - start),
      )
      return { tier: 3, status: "blocked", durationMs: Date.now() - start, reason }
    }

    // After the capture is drained, so these fetches never land in the captured
    // responses, the network log or the MHTML archive.
    const icons = capture.favicons ? await capturePageFavicons(page, maxTimeout - (Date.now() - start)) : undefined

    const cookies: Cookie[] = toCookies(await freshCtx.cookies())

    const captured = await captureResponse(mainResponse.response)

    return {
      tier: 3,
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
      tier: 3,
      status: "error",
      durationMs: Date.now() - start,
      reason:
        proxyUrl && isProxyTransportFailure(err)
          ? normalizeProxyError(err)
          : err instanceof Error
            ? err.message
            : String(err),
    }
  } finally {
    // Closing the context closes all of its pages. If Firefox wedges during cleanup,
    // ask the pool to replace this browser as soon as the lease is released.
    await close()
    disown()
  }
}

export async function runTier3(...args: Parameters<typeof runTier3Task>): Promise<Tier3Result> {
  const started = Date.now()
  const capture = args[9] ?? {}
  const budget = capture.budget ?? new RequestBudget(args[2])
  args[9] = { ...capture, budget }
  try {
    return await budget.run(() => runTier3Task(...args))
  } catch (error) {
    if (error instanceof DeadlineError)
      return { tier: 3, status: "timeout", reason: error.message, durationMs: Date.now() - started }
    throw error
  } finally {
    if (!capture.budget) budget.dispose()
  }
}
