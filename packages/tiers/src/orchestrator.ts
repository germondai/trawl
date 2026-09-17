import type { BrowserHandle } from "@trawl/browser"
import { FINGERPRINT, FINGERPRINT_POOL } from "@trawl/browser"
import type { BlockedEvidence, Cookie, ScrapeRequest, ScrapeResult, SessionData, TierResult } from "@trawl/types"
import { runTier1 } from "./tiers/1"
import { runTier2 } from "./tiers/2"
import { runTier3 } from "./tiers/3"
// Tier 4 (residential proxy) is dynamically imported only when needed.
import type { runTier4 } from "./tiers/4"
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
    )
    emit(t1)
    if (explicitProxy && t1.status === "error" && t1.reason?.startsWith("proxy-")) {
      throw new ScrapeError(t1.reason, timings)
    }
    if (hasUsablePayload(t1)) {
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
        body: t1.body,
        responseHeaders: t1.responseHeaders,
        contentType: t1.contentType,
      }
    }
    headful = t1.challenge === "datadome"
  }

  if (maxTier < 2) {
    throw new ScrapeError("Max tier reached without success", timings, blockedEvidence)
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
    if (session && maxTier >= 2) {
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
      emit(t2)
      if (hasUsablePayload(t2)) {
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
      // Session failed — purge it
      await deps.invalidateSession(domain)
    }

    if (maxTier < 3) {
      throw new ScrapeError("Max tier reached without success", timings, blockedEvidence)
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
      emit(t3)
      if (hasUsablePayload(t3)) {
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
      throw new ScrapeError("Max tier reached without success", timings, blockedEvidence)
    }

    // Tier 4: residential proxy escalation — requires at least one residential proxy,
    // supplied either per-request (req.proxy) or via the configured residential pool.
    let proxy4 = forcedTier4Proxy ?? req.proxy ?? deps.residentialProxyPool?.next(domain)
    if (!proxy4) {
      throw new ScrapeError(
        tier3Failure
          ? `Tier 3 failed (${tier3Failure}). Set RESIDENTIAL_PROXY_URL (or pass a proxy per-request) to enable Tier 4 proxy escalation.`
          : "Tier 4 requires RESIDENTIAL_PROXY_URL or a per-request proxy.",
        timings,
        blockedEvidence,
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
        )
      }

      const pool = deps.residentialProxyPool
      if (t4.status !== "blocked" || req.proxy || !pool || attempt + 1 >= MAX_PROXY_ATTEMPTS) break
      pool.markBad(proxy4)
      const next = pool.next(domain)
      if (!next || next === proxy4) break
      proxy4 = next
    }
    emit(t4)
    if (hasUsablePayload(t4)) {
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

    throw new ScrapeError(`All tiers exhausted. Last failure: ${t4.reason ?? t4.status}`, timings, blockedEvidence)
  } finally {
    if (!handleReleased) deps.releaseBrowser(handle)
  }
}
