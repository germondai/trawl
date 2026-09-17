import type { BrowserHandle } from "@trawl/browser"
import { FINGERPRINT, FINGERPRINT_POOL } from "@trawl/browser"
import type { BlockedEvidence, Cookie, ScrapeRequest, ScrapeResult, SessionData, TierResult } from "@trawl/types"
import { runTier1 } from "./tiers/1"
import { runTier2 } from "./tiers/2"
import { runTier3 } from "./tiers/3"
// Tier 4 (residential proxy) is dynamically imported only when needed.
import type { runTier4 } from "./tiers/4"
import { createCrossedLandingGuard, type LandingProbe } from "./utils/crossedLanding"
import { normalizeHtml } from "./utils/html"
import type { ProxyPool } from "./utils/proxyRotator"
import { requireContentTypeForBody, sanitizeHeaders } from "./utils/sanitize"

// Bounds how many distinct proxies a single request will try per tier before giving up —
// keeps a long proxy list from blowing the request's maxTimeout budget.
const MAX_PROXY_ATTEMPTS = 2

// Carries the per-tier attempt history alongside the failure message, so callers
// (the API layer) can report exactly which tier failed and why instead of just a
// flat string — this data already exists in-memory by the time we throw, it just
// wasn't reaching anyone outside the orchestrator.
export class ScrapeError extends Error {
  timings: TierResult[]
  // The challenge wall the last browser tier stopped at, when the caller asked for it.
  // It rides the error rather than a `blocked` ScrapeResult on purpose: a wall is not a
  // scrape, and callers keyed on the success shape must never be handed one.
  blockedEvidence?: BlockedEvidence
  constructor(message: string, timings: TierResult[], blockedEvidence?: BlockedEvidence) {
    super(message)
    this.name = "ScrapeError"
    this.timings = timings
    this.blockedEvidence = blockedEvidence
  }
}

// DataDome Device Check may require a browser running behind a real display. Keep that
// opt-in capacity separate so ordinary requests stay on the headless pool.
export interface AcquireOptions {
  headful?: boolean
}

export interface OrchestratorDeps {
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
  onTierAttempt?: (result: TierResult) => void
  validateOutboundUrl?: (url: string) => Promise<void>
  // Resolves the host a plain HTTP fetch of a URL ends on, for the crossed-landing guard.
  // Only consulted for requests that set `ignoreCertificateErrors`; defaults to a real
  // fetch through the same egress the scrape used.
  landingProbe?: LandingProbe
}

interface OrchestratorRunners {
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
  const totalStart = Date.now()
  const maxTimeout = req.maxTimeout ?? 60_000
  const maxTier = req.maxTier ?? 4
  const minTier = Math.max(deps.minTier ?? 1, req.skipHttp ? 2 : 1) as TierResult["tier"]
  const timings: TierResult[] = []
  const domain = extractDomain(req.url)
  const explicitProxy = req.proxy
  const tier1Proxy = explicitProxy && /^https?:\/\//i.test(explicitProxy) ? explicitProxy : undefined
  const skipTier1ForProxy = Boolean(explicitProxy && !tier1Proxy)

  if (minTier > maxTier) {
    throw new ScrapeError(`Minimum tier ${minTier} exceeds max tier ${maxTier}`, timings)
  }
  const forcedTier4Proxy = minTier === 4 ? (req.proxy ?? deps.residentialProxyPool?.next(domain)) : undefined
  if (minTier === 4 && !forcedTier4Proxy) {
    throw new ScrapeError("Tier 4 requires RESIDENTIAL_PROXY_URL or a per-request proxy.", timings)
  }

  // Evidence from the last browser tier that rendered a wall it could not clear. Kept out
  // of `timings` — that stays the thin, machine-readable attempt history — and reached
  // only via the thrown ScrapeError.
  let blockedEvidence: BlockedEvidence | undefined
  const capture = {
    consoleLogs: req.consoleLogs,
    networkLogs: req.networkLogs,
    redirectChain: req.redirectChain,
    captureResponses: req.captureResponses,
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

  const emit = (
    r: TierResult & {
      challenge?: unknown
      screenshot?: string
      consoleLogs?: unknown
      networkLogs?: unknown
      redirectChain?: unknown
      capturedResponses?: unknown
      mhtml?: unknown
    },
  ) => {
    const {
      challenge: _challenge,
      screenshot: _screenshot,
      consoleLogs: _consoleLogs,
      networkLogs: _networkLogs,
      redirectChain: _redirectChain,
      capturedResponses: _capturedResponses,
      mhtml: _mhtml,
      ...publicResult
    } = r
    timings.push(publicResult)
    deps.onTierAttempt?.(publicResult)
  }

  // Opting out of certificate verification also opts in to the crossed-landing guard: an
  // unverified connection no longer proves whose page came back, so a landing the requested
  // URL demonstrably does not lead to is refused instead of returned (see crossedLanding.ts).
  const ignoreCertificateErrors = Boolean(req.ignoreCertificateErrors)
  const crossedGuard = ignoreCertificateErrors ? createCrossedLandingGuard(req.url, deps.landingProbe) : undefined
  // Why the requested origin's certificate failed verification, when a tier observed it.
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
        // The probe runs inside what is left of the request's budget (floored inside the
        // guard, so a spent budget cannot turn the check into a no-op).
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
    )

  // Tier 1 is the only look at the wall that happens before a browser is checked out, so
  // it is also the only chance to pick the right kind of browser for the tiers below.
  let headful = false

  // Tier 1: plain HTTP fetch
  if (minTier <= 1 && !skipTier1ForProxy && maxTier >= 1) {
    // Tier 1 has no browser handle, so select its identity up front and use the
    // same UA for both the outbound request and the public result.
    const tier1Fingerprint = FINGERPRINT_POOL[Math.floor(Math.random() * FINGERPRINT_POOL.length)] ?? FINGERPRINT
    const t1 = await runTier1(
      req.url,
      { ...sanitizedHeaders, "User-Agent": tier1Fingerprint.userAgent },
      req.method,
      req.body,
      tier1Proxy,
      deps.validateOutboundUrl,
      ignoreCertificateErrors,
    )
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
          mhtml: t2.mhtml,
        }
      }
      // Session failed — purge it
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
          ignoreCertificateErrors,
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
            ignoreCertificateErrors,
          )
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
        if (cookies.length > 0 && !explicitProxy) {
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
          mhtml: t3.mhtml,
        }
      }
      tier3Failure = t3.reason ?? t3.status
    }

    if (maxTier < 4) {
      throw failure("Max tier reached without success")
    }

    // Tier 4: residential proxy escalation — requires at least one residential proxy,
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
        ignoreCertificateErrors,
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
          ignoreCertificateErrors,
        )
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
      if (cookies.length > 0 && !explicitProxy) {
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
        mhtml: t4.mhtml,
      }
    }

    throw failure(`All tiers exhausted. Last failure: ${t4.reason ?? t4.status}`)
  } finally {
    if (!handleReleased) deps.releaseBrowser(handle)
  }
}
