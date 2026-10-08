import type { BrowserHandle } from "@trawl/browser"
import { FINGERPRINT, FINGERPRINT_POOL, PoolExhaustedError } from "@trawl/browser"
import type { BlockedEvidence, Cookie, ScrapeRequest, ScrapeResult, SessionData, TierResult } from "@trawl/types"
import type { BrowserSessions } from "./browserSessions"
import { type ExternalCaptchaOptions, ExternalCaptchaSession } from "./solvers/externalCaptcha"
import { runTier1, type Tier1Result } from "./tiers/1"
import { runTier2, type Tier2Result } from "./tiers/2"
import { runTier3, type Tier3Result } from "./tiers/3"
// Tier 4 (residential proxy) is dynamically imported only when needed.
import type { runTier4, Tier4Result } from "./tiers/4"
import { anubisOomKills } from "./utils/anubisRetry"
import { normalizeInputCookies } from "./utils/cookies"
import { createCrossedLandingGuard, type LandingProbe } from "./utils/crossedLanding"
import { DeadlineError, RequestBudget } from "./utils/deadline"
import { normalizeHtml } from "./utils/html"
import { metaRefreshTarget } from "./utils/metaRefresh"
import type { ProxyPool } from "./utils/proxyRotator"
import { isHtmlContentType } from "./utils/response"
import { RequestValidationError, requireContentTypeForBody, sanitizeHeaders } from "./utils/sanitize"

// Bounds how many distinct proxies a single request will try per tier before giving up -
// keeps a long proxy list from blowing the request's maxTimeout budget.
const MAX_PROXY_ATTEMPTS = 2

type InternalTierResult = Tier1Result | Tier2Result | Tier3Result | Tier4Result

// Carries the per-tier attempt history alongside the failure message, so callers
// (the API layer) can report exactly which tier failed and why instead of just a
// flat string - this data already exists in-memory by the time we throw, it just
// wasn't reaching anyone outside the orchestrator.
export class ScrapeError extends Error {
  timings: TierResult[]
  // The challenge wall the last browser tier stopped at, when the caller asked for it.
  // It rides the error rather than a `blocked` ScrapeResult on purpose: a wall is not a
  // scrape, and callers keyed on the success shape must never be handed one.
  blockedEvidence?: BlockedEvidence
  captchaDiagnostics?: { kind: string; status: string }[]
  constructor(
    message: string,
    timings: TierResult[],
    blockedEvidence?: BlockedEvidence,
    captchaDiagnostics?: { kind: string; status: string }[],
  ) {
    super(message)
    this.name = "ScrapeError"
    this.timings = timings
    this.blockedEvidence = blockedEvidence
    this.captchaDiagnostics = captchaDiagnostics
  }
}

// DataDome Device Check may require a browser running behind a real display. Keep that
// opt-in capacity separate so ordinary requests stay on the headless pool.
export interface AcquireOptions {
  signal?: AbortSignal
  headful?: boolean
  browserId?: number
}

export interface OrchestratorDeps {
  sessions?: BrowserSessions
  acquireBrowser(domain: string, budgetMs?: number, options?: AcquireOptions): Promise<BrowserHandle>
  releaseBrowser(handle: BrowserHandle): void
  loadSession(domain: string): Promise<SessionData | undefined>
  saveSession(domain: string, data: SessionData): Promise<void>
  invalidateSession(domain: string): Promise<void>
  proxyPool?: ProxyPool
  residentialProxyPool?: ProxyPool
  // Deployment-wide lower bound for the escalation ladder. API request flags may
  // raise this floor, but never lower it.
  minTier?: TierResult["tier"]
  externalCaptcha?: ExternalCaptchaOptions
  onTierAttempt?: (result: TierResult) => void
  validateOutboundUrl?: (url: string) => Promise<void>
  // Resolves the host a plain HTTP fetch of a URL ends on, for the crossed-landing guard.
  // Only consulted for requests that set `ignoreCertificateErrors`; defaults to a real
  // fetch through the same egress the scrape used.
  landingProbe?: LandingProbe
  // Supplies a private CA only for an explicitly recognized, local proxy listener.
  trustedProxyCa?: (proxyUrl: string) => Promise<string | undefined>
}

interface OrchestratorRunners {
  oomKillCount?: typeof anubisOomKills
  tier1?: typeof runTier1
  tier2?: typeof runTier2
  tier3?: typeof runTier3
  tier4?: typeof runTier4
}

const extractDomain = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const hasUsablePayload = (result: { status: TierResult["status"]; html?: string; body?: Uint8Array }): boolean =>
  result.status === "success" && (result.body !== undefined || Boolean(result.html))

export async function scrape(
  req: ScrapeRequest,
  deps: OrchestratorDeps,
  runners: OrchestratorRunners = {},
): Promise<ScrapeResult> {
  const budget = new RequestBudget(req.maxTimeout ?? 60_000)
  const attempts: TierResult[] = []
  let ownedHandle: BrowserHandle | undefined
  const releaseOwned = (handle: BrowserHandle) => {
    if (handle !== ownedHandle) return
    ownedHandle = undefined
    deps.releaseBrowser(handle)
  }
  let acquiring = false
  let capacityExpired = false
  const onAbort = () => {
    capacityExpired = acquiring
  }
  budget.signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await budget.run(() =>
      scrapeWithinBudget(
        req,
        {
          ...deps,
          acquireBrowser: async (...args) => {
            acquiring = true
            try {
              const handle = await deps.acquireBrowser(args[0], args[1], { ...args[2], signal: budget.signal })
              if (budget.signal.aborted) {
                deps.releaseBrowser(handle)
                throw new DeadlineError()
              }
              ownedHandle = handle
              return handle
            } finally {
              acquiring = false
            }
          },
          releaseBrowser: releaseOwned,
          onTierAttempt: (attempt) => {
            attempts.push(attempt)
            deps.onTierAttempt?.(attempt)
          },
        },
        runners,
        budget,
      ),
    )
  } catch (error) {
    if (error instanceof DeadlineError) {
      if (ownedHandle) releaseOwned(ownedHandle)
      if (capacityExpired) throw new PoolExhaustedError()
      throw new ScrapeError(error.message, attempts)
    }
    throw error
  } finally {
    budget.signal.removeEventListener("abort", onAbort)
    budget.dispose()
  }
}

async function scrapeWithinBudget(
  req: ScrapeRequest,
  deps: OrchestratorDeps,
  runners: OrchestratorRunners,
  budget: RequestBudget,
): Promise<ScrapeResult> {
  const totalStart = Date.now()
  const namedSession = req.sessionId ? deps.sessions?.options(req.sessionId) : undefined
  if (req.sessionId && !deps.sessions) throw new RequestValidationError("Browser sessions are unavailable", 503)
  if (namedSession) {
    if (req.proxy !== undefined && req.proxy !== namedSession.proxy)
      throw new RequestValidationError("Session proxy is fixed at creation", 400)
    if (
      req.ignoreCertificateErrors !== undefined &&
      req.ignoreCertificateErrors !== Boolean(namedSession.ignoreCertificateErrors)
    )
      throw new RequestValidationError("Session TLS policy is fixed at creation", 400)
    req = { ...req, proxy: namedSession.proxy, ignoreCertificateErrors: namedSession.ignoreCertificateErrors }
  }
  const maxTimeout = req.maxTimeout ?? 60_000
  const maxTier = req.maxTier ?? 4
  if (req.cookies !== undefined) normalizeInputCookies(req.cookies, req.url)
  const importedCookies = Boolean(req.cookies?.length)
  const minTier = Math.max(deps.minTier ?? 1, importedCookies ? 3 : req.skipHttp ? 2 : 1) as TierResult["tier"]
  const timings: TierResult[] = []
  const domain = extractDomain(req.url)
  const explicitProxy = req.proxy
  const tier1Proxy = explicitProxy && /^https?:\/\//i.test(explicitProxy) ? explicitProxy : undefined
  const trustedProxyCa = explicitProxy ? await deps.trustedProxyCa?.(explicitProxy) : undefined
  const skipTier1ForProxy = Boolean(explicitProxy && !tier1Proxy)

  if (minTier > maxTier) {
    throw new ScrapeError(`Minimum tier ${minTier} exceeds max tier ${maxTier}`, timings)
  }
  const forcedTier4Proxy = minTier === 4 ? (req.proxy ?? deps.residentialProxyPool?.next(domain)) : undefined
  if (minTier === 4 && !forcedTier4Proxy) {
    throw new ScrapeError("Tier 4 requires RESIDENTIAL_PROXY_URL or a per-request proxy.", timings)
  }

  // Evidence from the last browser tier that rendered a wall it could not clear. Kept out
  // of `timings` - that stays the thin, machine-readable attempt history - and reached
  // only via the thrown ScrapeError.
  let blockedEvidence: BlockedEvidence | undefined
  const capture = {
    cookies: req.cookies,
    budget,
    externalCaptcha: deps.externalCaptcha ? new ExternalCaptchaSession(deps.externalCaptcha) : undefined,
    followMetaRefresh: req.followMetaRefresh,
    screenshotFullPage: req.screenshotFullPage,
    screenshotWaitForSelector: req.screenshotWaitForSelector,
    screenshotSelector: req.screenshotSelector,
    contentWaitForSelector: req.contentWaitForSelector,
    consoleLogs: req.consoleLogs,
    networkLogs: req.networkLogs,
    redirectChain: req.redirectChain,
    captureResponses: req.captureResponses,
    favicons: req.favicons,
    settleTimeout: req.settleTimeout,
    waitForSelector: req.waitForSelector,
    blockedEvidence: req.blockedEvidence
      ? {
          screenshot: req.screenshot,
          report: (evidence: BlockedEvidence) => {
            blockedEvidence = evidence
          },
        }
      : undefined,
    mhtml: req.mhtml,
  }

  const sanitizedHeaders = sanitizeHeaders(req.headers)
  requireContentTypeForBody(sanitizedHeaders, Boolean(req.body))

  const emit = (r: InternalTierResult) => {
    const publicResult: TierResult = {
      tier: r.tier,
      status: r.status,
      durationMs: r.durationMs,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
    }
    timings.push(publicResult)
    deps.onTierAttempt?.(publicResult)
  }

  // Opting out of certificate verification also opts in to the crossed-landing guard: an
  // unverified connection no longer proves whose page came back, so a landing the requested
  // URL demonstrably does not lead to is refused instead of returned (see crossedLanding.ts).
  const ignoreCertificateErrors = Boolean(req.ignoreCertificateErrors)
  const crossedGuard = ignoreCertificateErrors ? createCrossedLandingGuard(req.url, deps.landingProbe) : undefined
  // Why certificate verification failed on a Tier 1 hop, when one was observed.
  let certificateError: string | undefined
  // The last landing this request refused, so the terminal error names it.
  let crossedHost: string | undefined

  // A refused landing is not a page: it is reported as a failed attempt for that tier and
  // the ladder moves on to the next rung, which reaches the origin over a different egress.
  const refuseCrossed = async (
    effectiveUrl: string | undefined,
    userAgent: string | undefined,
    proxy: string | undefined,
  ): Promise<string | undefined> => {
    const host =
      (await crossedGuard?.check(effectiveUrl, {
        proxy,
        userAgent,
        ignoreCertificateErrors,
        // The probe shares what is left of the request's budget across all of its hops.
        timeoutMs: maxTimeout - (Date.now() - totalStart),
        validateOutboundUrl: deps.validateOutboundUrl,
      })) ?? undefined
    if (host) crossedHost = host
    return host
  }

  const crossedTiming = (result: TierResult, host: string): TierResult => ({
    tier: result.tier,
    status: "error",
    durationMs: result.durationMs,
    reason: `crossed-landing on ${host}`,
  })

  // A refused landing is the security-relevant half of any terminal failure that had one,
  // so it is named alongside whatever the last tier reported.
  const failure = (message: string): ScrapeError =>
    new ScrapeError(
      crossedHost
        ? `${message} — refused crossed landing on ${crossedHost}: ${req.url} does not lead there and its certificate was not verified`
        : message,
      timings,
      blockedEvidence,
      capture.externalCaptcha?.diagnostics(),
    )

  if (req.sessionId) {
    if (maxTier < 3) throw new RequestValidationError("Browser sessions require maxTier >= 3", 400)
    if (minTier === 4 && !namedSession?.proxy)
      throw new RequestValidationError("Minimum tier 4 requires a proxy set on session creation", 400)
    const sessions = deps.sessions
    if (!sessions) throw new RequestValidationError("Browser sessions are unavailable", 503)
    return sessions.use(req.sessionId, domain, budget, async (handle, context, storage) => {
      const sessionCapture = {
        ...capture,
        sessionContext: context,
        sessionStorage: storage,
      }
      const result =
        minTier === 4
          ? await (runners.tier4 ?? (await import("./tiers/4")).runTier4)(
              req.url,
              handle,
              budget.remaining(),
              req.proxy as string,
              sanitizedHeaders,
              req.method,
              req.body,
              deps.validateOutboundUrl,
              req.screenshot,
              sessionCapture,
              ignoreCertificateErrors,
            )
          : await (runners.tier3 ?? runTier3)(
              req.url,
              handle,
              budget.remaining(),
              namedSession?.proxy,
              sanitizedHeaders,
              req.method,
              req.body,
              deps.validateOutboundUrl,
              req.screenshot,
              sessionCapture,
              ignoreCertificateErrors,
            )
      const crossed = hasUsablePayload(result)
        ? await refuseCrossed(result.effectiveUrl, result.userAgent, namedSession?.proxy)
        : undefined
      emit(crossed ? crossedTiming(result, crossed) : result)
      if (!hasUsablePayload(result) || crossed) throw failure(result.reason ?? "Session scrape failed")
      return {
        url: result.effectiveUrl ?? req.url,
        html: normalizeHtml(result.html ?? ""),
        cookies: result.cookies ?? [],
        userAgent: result.userAgent ?? handle.fingerprint.userAgent,
        statusCode: result.statusCode ?? 200,
        tier: result.tier,
        sessionCached: false,
        timings,
        totalMs: Date.now() - totalStart,
        proxyUsed: Boolean(namedSession?.proxy),
        captchasSolved: result.captchasSolved,
        captchaDiagnostics: capture.externalCaptcha?.diagnostics(),
        body: result.body,
        responseHeaders: result.responseHeaders,
        contentType: result.contentType,
        screenshot: result.screenshot,
        consoleLogs: result.consoleLogs,
        networkLogs: result.networkLogs,
        redirectChain: result.redirectChain,
        capturedResponses: result.capturedResponses,
        favicons: result.favicons,
        mhtml: result.mhtml,
      }
    })
  }

  // Tier 1 is the only look at the wall that happens before a browser is checked out, so
  // it is also the only chance to pick the right kind of browser for the tiers below.
  let headful = false

  // Tier 1: plain HTTP fetch
  if (minTier <= 1 && !skipTier1ForProxy && maxTier >= 1) {
    // Tier 1 has no browser handle, so select its identity up front and use the
    // same UA for both the outbound request and the public result.
    const tier1Fingerprint = FINGERPRINT_POOL[Math.floor(Math.random() * FINGERPRINT_POOL.length)] ?? FINGERPRINT
    const tier1Runner = runners.tier1 ?? runTier1
    const t1 = await tier1Runner(
      req.url,
      { ...sanitizedHeaders, "User-Agent": tier1Fingerprint.userAgent },
      req.method,
      req.body,
      tier1Proxy,
      deps.validateOutboundUrl,
      ignoreCertificateErrors,
      trustedProxyCa,
      budget.signal,
    )
    if (req.followMetaRefresh && t1.status === "success" && t1.html && isHtmlContentType(t1.contentType)) {
      const refresh = await metaRefreshTarget(t1.html, t1.effectiveUrl ?? req.url)
      if (refresh) {
        t1.status = "needs-js"
        t1.reason = "meta-refresh-needs-browser"
      }
    }
    if (
      t1.status === "success" &&
      t1.html &&
      isHtmlContentType(t1.contentType) &&
      deps.externalCaptcha?.profiles?.some(
        (profile) => profile.hostname === new URL(t1.effectiveUrl ?? req.url).hostname,
      )
    ) {
      t1.status = "needs-js"
      t1.reason = "external-captcha-profile-needs-browser"
    }
    if (ignoreCertificateErrors) certificateError = t1.certificateError
    const crossed1 = hasUsablePayload(t1)
      ? await refuseCrossed(t1.effectiveUrl, tier1Fingerprint.userAgent, tier1Proxy)
      : undefined
    emit(crossed1 ? crossedTiming(t1, crossed1) : t1)
    if (explicitProxy && t1.status === "error" && t1.reason?.startsWith("proxy-")) {
      throw new ScrapeError(t1.reason, timings)
    }
    if (hasUsablePayload(t1) && !crossed1) {
      return {
        url: t1.effectiveUrl ?? req.url,
        html: normalizeHtml(t1.html ?? ""),
        cookies: [],
        userAgent: tier1Fingerprint.userAgent,
        statusCode: t1.statusCode ?? 200,
        tier: 1,
        sessionCached: false,
        timings,
        totalMs: Date.now() - totalStart,
        proxyUsed: Boolean(tier1Proxy),
        certificateError,
        body: t1.body,
        responseHeaders: t1.responseHeaders,
        contentType: t1.contentType,
      }
    }
    headful = t1.challenge === "datadome"
  }

  if (maxTier < 2) {
    throw failure("Max tier reached without success")
  }

  budget.check()
  // Acquire browser for tiers 2-4
  // Pass our own budget so the pool's stall detector doesn't reclaim this browser
  // while the request is still inside the time the caller asked for.
  let handle = await deps.acquireBrowser(domain, Math.max(maxTimeout - (Date.now() - totalStart), 0), { headful })
  let handleReleased = false

  const switchToHeadful = async (): Promise<void> => {
    if (handle.headful) return
    deps.releaseBrowser(handle)
    handleReleased = true
    handle = await deps.acquireBrowser(domain, Math.max(maxTimeout - (Date.now() - totalStart), 0), { headful: true })
    handleReleased = false
  }

  // A Camoufox content process can crash while running Anubis workers. Retry
  // once in a new context on the same proxy, only for safe requests and within
  // the original budget. A browser failure does not make a proxy unhealthy.
  const oomKillCount = runners.oomKillCount ?? anubisOomKills
  const initialOomKills = oomKillCount()
  let anubisCrashRetried = false
  const retryAnubisCrash = (result: TierResult): boolean => {
    if (anubisCrashRetried || result.status !== "error" || result.reason !== "anubis-browser-closed") return false
    if (req.method && req.method !== "GET" && req.method !== "HEAD") return false
    if (Date.now() - totalStart >= maxTimeout) return false
    if (typeof handle.browser.isConnected === "function" && !handle.browser.isConnected()) return false
    const currentOomKills = oomKillCount()
    if (initialOomKills !== undefined && currentOomKills !== undefined && currentOomKills !== initialOomKills)
      return false
    anubisCrashRetried = true
    emit(result)
    return true
  }

  try {
    // Tier 2: browser with cached session
    const session = minTier <= 2 && !explicitProxy ? await deps.loadSession(domain) : undefined
    if (session && maxTier >= 2 && ignoreCertificateErrors) {
      // Tier 2 replays the cached session inside the pool's shared browser context, whose
      // TLS policy is fixed when the browser launches and stays verified for every other
      // caller. There is no per-request exception to make there, so the ladder goes straight
      // to the fresh-context tiers instead of spending the session on a handshake this
      // request has already been told to tolerate.
      emit({ tier: 2, status: "skipped", durationMs: 0, reason: "ignore-certificate-errors-needs-fresh-context" })
    } else if (session && maxTier >= 2) {
      const remaining = maxTimeout - (Date.now() - totalStart)
      const tier2Runner = runners.tier2 ?? runTier2
      let t2 = await tier2Runner(
        req.url,
        handle,
        session,
        remaining,
        sanitizedHeaders,
        req.method,
        req.body,
        deps.validateOutboundUrl,
        req.screenshot,
        capture,
      )
      if (t2.challenge === "datadome" && !handle.headful) {
        await switchToHeadful()
        t2 = await tier2Runner(
          req.url,
          handle,
          session,
          maxTimeout - (Date.now() - totalStart),
          sanitizedHeaders,
          req.method,
          req.body,
          deps.validateOutboundUrl,
          req.screenshot,
          capture,
        )
      }
      // Unreachable while the skip above stands, and kept anyway: every tier that can
      // return a page runs the guard, so re-enabling Tier 2 here cannot quietly bypass it.
      const crossed2 = hasUsablePayload(t2)
        ? await refuseCrossed(t2.effectiveUrl, session.userAgent, undefined)
        : undefined
      emit(crossed2 ? crossedTiming(t2, crossed2) : t2)
      if (hasUsablePayload(t2) && !crossed2) {
        if (t2.cookies && t2.cookies.length > 0) {
          await deps.saveSession(domain, {
            cookies: t2.cookies,
            userAgent: session.userAgent,
            savedAt: Date.now(),
          })
        }
        return {
          url: t2.effectiveUrl ?? req.url,
          html: normalizeHtml(t2.html ?? ""),
          cookies: t2.cookies ?? [],
          userAgent: session.userAgent,
          statusCode: t2.statusCode ?? 200,
          tier: 2,
          sessionCached: true,
          timings,
          totalMs: Date.now() - totalStart,
          captchasSolved: t2.captchasSolved,
          captchaDiagnostics: capture.externalCaptcha?.diagnostics(),
          proxyUsed: false,
          certificateError,
          body: t2.body,
          responseHeaders: t2.responseHeaders,
          contentType: t2.contentType,
          screenshot: t2.screenshot,
          consoleLogs: t2.consoleLogs,
          networkLogs: t2.networkLogs,
          redirectChain: t2.redirectChain,
          capturedResponses: t2.capturedResponses,
          favicons: t2.favicons,
          mhtml: t2.mhtml,
        }
      }
      // Session failed - purge it
      await deps.invalidateSession(domain)
    }

    if (maxTier < 3) {
      throw failure("Max tier reached without success")
    }

    let tier3Failure: string | undefined
    if (minTier <= 3) {
      // Tier 3: fresh challenge solve. Proxy resolves from (priority order) a per-request
      // override, then the configured datacenter proxy pool, then none (server's own IP).
      // On a "blocked" result from a pool-sourced proxy, mark it bad and retry with the
      // next pool proxy before falling through to Tier 4. A per-request override has no
      // fallback candidate, so it's tried exactly once.
      let proxy3 = req.proxy ?? deps.proxyPool?.next(domain) ?? undefined
      let t3: Awaited<ReturnType<typeof runTier3>>
      for (let attempt = 0; ; attempt++) {
        budget.check()
        const remaining3 = maxTimeout - (Date.now() - totalStart)
        const tier3Runner = runners.tier3 ?? runTier3
        t3 = await tier3Runner(
          req.url,
          handle,
          remaining3,
          proxy3,
          sanitizedHeaders,
          req.method,
          req.body,
          deps.validateOutboundUrl,
          req.screenshot,
          capture,
          ignoreCertificateErrors || Boolean(trustedProxyCa && proxy3 === explicitProxy),
        )
        if (t3.challenge === "datadome" && !handle.headful) {
          await switchToHeadful()
          t3 = await tier3Runner(
            req.url,
            handle,
            maxTimeout - (Date.now() - totalStart),
            proxy3,
            sanitizedHeaders,
            req.method,
            req.body,
            deps.validateOutboundUrl,
            req.screenshot,
            capture,
            ignoreCertificateErrors || Boolean(trustedProxyCa && proxy3 === explicitProxy),
          )
        }

        if (retryAnubisCrash(t3)) {
          attempt--
          continue
        }
        const pool = deps.proxyPool
        if (t3.status !== "blocked" || req.proxy || !proxy3 || !pool || attempt + 1 >= MAX_PROXY_ATTEMPTS) break
        pool.markBad(proxy3)
        const next = pool.next(domain)
        if (!next || next === proxy3) break
        console.log(
          `[orchestrator] Tier 3 proxy ${proxy3.replace(/\/\/[^@]*@/, "//**@")} blocked — retrying with next proxy`,
        )
        proxy3 = next
      }
      const crossed3 = hasUsablePayload(t3) ? await refuseCrossed(t3.effectiveUrl, t3.userAgent, proxy3) : undefined
      emit(crossed3 ? crossedTiming(t3, crossed3) : t3)
      if (hasUsablePayload(t3) && !crossed3) {
        const cookies: Cookie[] = t3.cookies ?? []
        if (cookies.length > 0 && !explicitProxy && !importedCookies) {
          await deps.saveSession(domain, {
            cookies,
            userAgent: t3.userAgent ?? handle.fingerprint.userAgent,
            savedAt: Date.now(),
          })
        }
        return {
          url: t3.effectiveUrl ?? req.url,
          html: normalizeHtml(t3.html ?? ""),
          cookies,
          userAgent: t3.userAgent ?? FINGERPRINT.userAgent,
          statusCode: t3.statusCode ?? 200,
          tier: 3,
          sessionCached: false,
          timings,
          totalMs: Date.now() - totalStart,
          captchasSolved: t3.captchasSolved,
          captchaDiagnostics: capture.externalCaptcha?.diagnostics(),
          proxyUsed: Boolean(proxy3),
          certificateError,
          body: t3.body,
          responseHeaders: t3.responseHeaders,
          contentType: t3.contentType,
          screenshot: t3.screenshot,
          consoleLogs: t3.consoleLogs,
          networkLogs: t3.networkLogs,
          redirectChain: t3.redirectChain,
          capturedResponses: t3.capturedResponses,
          favicons: t3.favicons,
          mhtml: t3.mhtml,
        }
      }
      tier3Failure = t3.reason ?? t3.status
    }

    if (maxTier < 4) {
      throw failure("Max tier reached without success")
    }

    // Tier 4: residential proxy escalation - requires at least one residential proxy,
    // supplied either per-request (req.proxy) or via the configured residential pool.
    let proxy4 = forcedTier4Proxy ?? req.proxy ?? deps.residentialProxyPool?.next(domain)
    if (!proxy4) {
      throw failure(
        tier3Failure
          ? `Tier 3 failed (${tier3Failure}). Set RESIDENTIAL_PROXY_URL (or pass a proxy per-request) to enable Tier 4 proxy escalation.`
          : "Tier 4 requires RESIDENTIAL_PROXY_URL or a per-request proxy.",
      )
    }

    let t4: Awaited<ReturnType<typeof runTier4>>
    const runTier4Lazy = runners.tier4 ?? (await import("./tiers/4")).runTier4
    for (let attempt = 0; ; attempt++) {
      console.log(`[orchestrator] Tier 4 via residential proxy: ${proxy4.replace(/\/\/[^@]*@/, "//**@")}`)
      budget.check()
      const remaining4 = maxTimeout - (Date.now() - totalStart)
      t4 = await runTier4Lazy(
        req.url,
        handle,
        remaining4,
        proxy4,
        sanitizedHeaders,
        req.method,
        req.body,
        deps.validateOutboundUrl,
        req.screenshot,
        capture,
        ignoreCertificateErrors || Boolean(trustedProxyCa && proxy4 === explicitProxy),
      )
      if (t4.challenge === "datadome" && !handle.headful) {
        await switchToHeadful()
        t4 = await runTier4Lazy(
          req.url,
          handle,
          maxTimeout - (Date.now() - totalStart),
          proxy4,
          sanitizedHeaders,
          req.method,
          req.body,
          deps.validateOutboundUrl,
          req.screenshot,
          capture,
          ignoreCertificateErrors || Boolean(trustedProxyCa && proxy4 === explicitProxy),
        )
      }

      if (retryAnubisCrash(t4)) {
        attempt--
        continue
      }
      const pool = deps.residentialProxyPool
      if (t4.status !== "blocked" || req.proxy || !pool || attempt + 1 >= MAX_PROXY_ATTEMPTS) break
      pool.markBad(proxy4)
      const next = pool.next(domain)
      if (!next || next === proxy4) break
      proxy4 = next
    }
    const crossed4 = hasUsablePayload(t4) ? await refuseCrossed(t4.effectiveUrl, t4.userAgent, proxy4) : undefined
    emit(crossed4 ? crossedTiming(t4, crossed4) : t4)
    if (hasUsablePayload(t4) && !crossed4) {
      const cookies: Cookie[] = t4.cookies ?? []
      if (cookies.length > 0 && !explicitProxy && !importedCookies) {
        await deps.saveSession(domain, {
          cookies,
          userAgent: t4.userAgent ?? handle.fingerprint.userAgent,
          savedAt: Date.now(),
        })
      }
      return {
        url: t4.effectiveUrl ?? req.url,
        html: normalizeHtml(t4.html ?? ""),
        cookies,
        userAgent: t4.userAgent ?? FINGERPRINT.userAgent,
        statusCode: t4.statusCode ?? 200,
        tier: 4,
        sessionCached: false,
        timings,
        totalMs: Date.now() - totalStart,
        captchasSolved: t4.captchasSolved,
        captchaDiagnostics: capture.externalCaptcha?.diagnostics(),
        proxyUsed: true,
        certificateError,
        body: t4.body,
        responseHeaders: t4.responseHeaders,
        contentType: t4.contentType,
        screenshot: t4.screenshot,
        consoleLogs: t4.consoleLogs,
        networkLogs: t4.networkLogs,
        redirectChain: t4.redirectChain,
        capturedResponses: t4.capturedResponses,
        favicons: t4.favicons,
        mhtml: t4.mhtml,
      }
    }

    throw failure(`All tiers exhausted. Last failure: ${t4.reason ?? t4.status}`)
  } finally {
    if (!handleReleased) deps.releaseBrowser(handle)
  }
}
