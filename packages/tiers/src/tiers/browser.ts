import type { BrowserHandle } from "@trawl/browser"
import { closeTemporaryContext, FINGERPRINT, newFreshContext } from "@trawl/browser"
import type { Cookie } from "@trawl/types"
import { capturePageFavicons } from "../favicons"
import { solvePageCaptchas } from "../solvers"
import { reportBlocked } from "../utils/blockedEvidence"
import { captureBrowserDocument, waitForBrowserLoad } from "../utils/browserCapture"
import { persistentBrowserWall } from "../utils/browserWall"
import { attachPageCapture, type CaptureOptions } from "../utils/capture"
import { routeChallengeWait } from "../utils/challengeRouter"
import { normalizeInputCookies, snapshotChallengeCookies, toCookies } from "../utils/cookies"
import { DeadlineError, RequestBudget, sleep } from "../utils/deadline"
import { type ChallengeType, hasAnubisChallenge, isBrowserErrorPage, isCloudflarePage } from "../utils/detect"
import { trackMainDocumentResponses } from "../utils/mainResponse"
import { followMetaRefresh } from "../utils/metaRefresh"
import { isHardNetworkFailure } from "../utils/network"
import { installOutboundPolicy, type OutboundUrlValidator } from "../utils/outboundPolicy"
import { isProxyTransportFailure, normalizeProxyError, proxyResponseFailure } from "../utils/proxyFailure"
import { browserDocumentHtml, captureResponse, isHtmlContentType, isNonHtmlTextContentType } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"
import { restoreSessionStorage } from "../utils/sessionStorage"
import type { BrowserTierResult } from "./browserResult"

// Clearance without navigation can indicate an egress-IP block.
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

async function runBrowserTierTask<T extends 3 | 4>(
  tier: T,
  url: string,
  handle: BrowserHandle,
  _maxTimeout: number,
  proxyUrl?: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  validateOutboundUrl?: OutboundUrlValidator,
  screenshot?: boolean,
  capture: CaptureOptions = {},
  ignoreCertificateErrors?: boolean,
): Promise<BrowserTierResult<T>> {
  const start = Date.now()

  // Fresh contexts isolate ordinary solves; named sessions retain their login state.
  let context: Awaited<ReturnType<typeof newFreshContext>> | undefined
  let openingContext: ReturnType<typeof newFreshContext> | undefined

  const budget = capture.budget
  if (!budget) throw new Error("Browser task requires an operation budget")
  let cleanup: Promise<void> | undefined
  const close = () =>
    (cleanup ??= closeTemporaryContext(
      capture.sessionContext ? undefined : (openingContext ?? context),
      handle.requestBrowserReplacement,
      `tier${tier} context cleanup timed out`,
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
    context = await openingContext
    budget.check()
    if (capture.cookies?.length) {
      await context.clearCookies()
      await context.addCookies(normalizeInputCookies(capture.cookies, url))
    }
    const page = await context.newPage()
    const storageRestore = capture.sessionStorage?.size
      ? await restoreSessionStorage(page, capture.sessionStorage)
      : undefined
    budget.check()
    page.setDefaultTimeout?.(Math.max(1, budget.remaining()))
    await installOutboundPolicy(page, validateOutboundUrl)
    const initialCookies = snapshotChallengeCookies(await context.cookies())
    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    const pageCapture = attachPageCapture(page, capture)
    const mainResponse = trackMainDocumentResponses(page, { redirectChain: capture.redirectChain })

    // CF challenges can trigger sub-navigations that throw "navigation interrupted" -
    // we catch those so we can continue. Hard failures (DNS, connection refused) are
    // rethrown so they surface as proper errors.
    const gotoErr = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1, Math.min(budget.remaining(), 30_000)),
      })
      .catch((e: Error) => e)
    await storageRestore?.dispose()

    // Abort early on hard network failures - no point running challenge wait
    if (isHardNetworkFailure(gotoErr)) {
      return {
        tier,
        status: "error",
        durationMs: Date.now() - start,
        reason:
          tier === 4 || (proxyUrl && isProxyTransportFailure(gotoErr))
            ? normalizeProxyError(gotoErr)
            : gotoErr.message.split("\n")[0],
      }
    }
    const earlyProxyFailure = proxyUrl ? proxyResponseFailure(mainResponse.status, mainResponse.headers) : undefined
    if (earlyProxyFailure) {
      return { tier, status: "error", durationMs: Date.now() - start, reason: earlyProxyFailure }
    }
    // Otherwise (navigation interrupted by CF redirect) - fall through and keep going

    const anubisRefresh = capture.followMetaRefresh && hasAnubisChallenge(await page.content().catch(() => ""))
    const refresh =
      capture.followMetaRefresh && !anubisRefresh
        ? await followMetaRefresh(page, budget.remaining(), validateOutboundUrl)
        : undefined
    if (refresh && refresh.status !== "ok") {
      return { tier, status: refresh.status, durationMs: Date.now() - start, reason: refresh.reason }
    }

    const remaining = budget.remaining()
    const peekHtml = await page.content().catch(() => "")
    const cloudflareWall = isCloudflarePage(peekHtml, mainResponse.headers)
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
      return { tier, status: "error", reason: "anubis-browser-closed", durationMs: Date.now() - start }
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
              ? tier === 4
                ? "proxy-ip-blocked"
                : (DATACENTER_BLOCKED_REASONS[challengeType] ?? DEFAULT_DATACENTER_BLOCKED_REASON)
              : `${challengeType === "none" ? "cloudflare" : challengeType}-challenge-timeout`
      await reportBlocked(
        page,
        capture.blockedEvidence,
        { tier, status, reason, statusCode: mainResponse.status, html: peekHtml },
        budget.remaining(),
      )
      return { tier, status, durationMs: Date.now() - start, reason }
    }

    if (anubisRefresh) {
      const destination = await followMetaRefresh(page, budget.remaining(), validateOutboundUrl)
      if (destination.status !== "ok") {
        return { tier, status: destination.status, durationMs: Date.now() - start, reason: destination.reason }
      }
    }

    // Keep default settling for JS content and lingering Cloudflare frames.
    if (cloudflareWall || (tier === 3 && challengeType !== "anubis" && !capture.contentWaitForSelector))
      await sleep(600, budget.signal)
    if (tier === 4) await waitForBrowserLoad(page, capture, budget, 10_000)

    const solveRemaining = budget.remaining()
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

    const { html, shot, evidence } = await captureBrowserDocument(page, capture, pageCapture, budget, screenshot)

    const wall = persistentBrowserWall(html, page.url(), mainResponse.headers, mainResponse.status, challengeType)
    // Anubis verification URLs and Google's sorry URL identify a wall even when
    // the document is empty. Other providers follow the network-error checks.
    if (wall?.reason !== "anubis-persistent" && wall?.reason !== "google-sorry-persistent") {
      // Empty shell means the browser got nothing - treat as a load failure
      if (
        html.length < 100 &&
        challengeType !== "anubis" &&
        !isNonHtmlTextContentType(mainResponse.headers["content-type"])
      ) {
        const errMsg =
          tier === 3 && gotoErr instanceof Error ? gotoErr.message.split("\n")[0] : "page returned empty content"
        return { tier, status: "error", durationMs: Date.now() - start, reason: errMsg }
      }

      // Browser never reached a real server (DNS/connection/TLS failure) - the "navigation
      // interrupted" tolerance above lets Firefox-specific network errors fall through
      // instead of hitting the isHardFail regex (which only matches Chromium ERR_* strings),
      // so we still need to catch the resulting about:neterror page here.
      if (isBrowserErrorPage(html)) {
        const errMsg =
          tier === 4 || proxyUrl
            ? "proxy-connection-failed"
            : gotoErr instanceof Error
              ? gotoErr.message.split("\n")[0]
              : "browser network error (about:neterror)"
        return { tier, status: "error", durationMs: Date.now() - start, reason: errMsg }
      }
    }

    if (wall) {
      await reportBlocked(
        page,
        capture.blockedEvidence,
        { tier, status: "blocked", reason: wall.reason, statusCode: mainResponse.status, html, screenshot: shot },
        budget.remaining(),
      )
      return { tier, status: "blocked", durationMs: Date.now() - start, ...wall }
    }

    // After the capture is drained, so these fetches never land in the captured
    // responses, the network log or the MHTML archive.
    const icons = capture.favicons ? await capturePageFavicons(page, budget.remaining()) : undefined

    const cookies: Cookie[] = toCookies(await context.cookies())

    const captured = await captureResponse(mainResponse.response)

    return {
      tier,
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
      tier,
      status: "error",
      durationMs: Date.now() - start,
      reason:
        tier === 4 || (proxyUrl && isProxyTransportFailure(err))
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

export async function runBrowserTier<T extends 3 | 4>(
  tier: T,
  ...args: Parameters<typeof runBrowserTierTask<T>> extends [T, ...infer A] ? A : never
): Promise<BrowserTierResult<T>> {
  const started = Date.now()
  const capture = args[9] ?? {}
  const budget = capture.budget ?? new RequestBudget(args[2])
  args[9] = { ...capture, budget }
  try {
    return await budget.run(() => runBrowserTierTask(tier, ...args))
  } catch (error) {
    if (error instanceof DeadlineError)
      return { tier, status: "timeout", reason: error.message, durationMs: Date.now() - started }
    throw error
  } finally {
    if (!capture.budget) budget.dispose()
  }
}
