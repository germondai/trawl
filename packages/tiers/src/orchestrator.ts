import type { BrowserHandle } from "@trawl/browser"
import { FINGERPRINT, FINGERPRINT_POOL } from "@trawl/browser"
import type { Cookie, ScrapeRequest, ScrapeResult, SessionData, TierResult } from "@trawl/types"
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
  constructor(message: string, timings: TierResult[]) {
    super(message)
    this.name = "ScrapeError"
    this.timings = timings
  }
}

// DataDome is the only wall TRAWL handles that reads headless signals directly: a headless
// browser fails its Device Check whatever the fingerprint says, while Cloudflare, Akamai,
// Imperva and DDoS-Guard all resolve headless. Asking for a headful browser only when the
// wall calls for it keeps the common path on the faster headless pool.
export interface AcquireOptions {
  headful?: boolean
}

export interface OrchestratorDeps {
  acquireBrowser(domain: string, budgetMs?: number, options?: AcquireOptions): Promise<BrowserHandle>
  releaseBrowser(id: number, lease?: number): void
  loadSession(domain: string): Promise<SessionData | undefined>
  saveSession(domain: string, data: SessionData): Promise<void>
  invalidateSession(domain: string): Promise<void>
  proxyPool?: ProxyPool
  residentialProxyPool?: ProxyPool
  onTierAttempt?: (result: TierResult) => void
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

export async function scrape(req: ScrapeRequest, deps: OrchestratorDeps): Promise<ScrapeResult> {
  const totalStart = Date.now()
  const maxTimeout = req.maxTimeout ?? 60_000
  const maxTier = req.maxTier ?? 4
  const timings: TierResult[] = []
  const domain = extractDomain(req.url)

  const sanitizedHeaders = sanitizeHeaders(req.headers)
  requireContentTypeForBody(sanitizedHeaders, Boolean(req.body))

  const emit = (r: TierResult) => {
    timings.push(r)
    deps.onTierAttempt?.(r)
  }

  // Tier 1 is the only look at the wall that happens before a browser is checked out, so
  // it is also the only chance to pick the right kind of browser for the tiers below.
  let headful = false

  // Tier 1: plain HTTP fetch
  if (!req.skipHttp && maxTier >= 1) {
    const t1 = await runTier1(req.url, sanitizedHeaders, req.method, req.body)
    emit(t1)
    if (hasUsablePayload(t1)) {
      // Tier 1 doesn't acquire a browser (it's a plain HTTP fetch). Use a random fingerprint
      // UA from the pool so even Tier 1 requests don't share a single signature.
      const tier1UA = FINGERPRINT_POOL[Math.floor(Math.random() * FINGERPRINT_POOL.length)].userAgent
      return {
        url: t1.effectiveUrl ?? req.url,
        html: normalizeHtml(t1.html ?? ""),
        cookies: [],
        userAgent: tier1UA,
        statusCode: t1.statusCode ?? 200,
        tier: 1,
        sessionCached: false,
        timings,
        totalMs: Date.now() - totalStart,
        proxyUsed: false,
        body: t1.body,
        responseHeaders: t1.responseHeaders,
        contentType: t1.contentType,
      }
    }
    headful = t1.challenge === "datadome"
  }

  if (maxTier < 2) {
    throw new ScrapeError("Max tier reached without success", timings)
  }

  // Acquire browser for tiers 2-4
  // Pass our own budget so the pool's stall detector doesn't reclaim this browser
  // while the request is still inside the time the caller asked for.
  const handle = await deps.acquireBrowser(domain, Math.max(maxTimeout - (Date.now() - totalStart), 0), { headful })

  try {
    // Tier 2: browser with cached session
    const session = await deps.loadSession(domain)
    if (session && maxTier >= 2) {
      const remaining = maxTimeout - (Date.now() - totalStart)
      const t2 = await runTier2(req.url, handle, session, remaining, sanitizedHeaders, req.method, req.body)
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
        }
      }
      // Session failed — purge it
      await deps.invalidateSession(domain)
    }

    if (maxTier < 3) {
      throw new ScrapeError("Max tier reached without success", timings)
    }

    // Tier 3: fresh challenge solve. Proxy resolves from (priority order) a per-request
    // override, then the configured datacenter proxy pool, then none (server's own IP).
    // On a "blocked" result from a pool-sourced proxy, mark it bad and retry with the
    // next pool proxy before falling through to Tier 4. A per-request override has no
    // fallback candidate, so it's tried exactly once.
    let proxy3 = req.proxy ?? deps.proxyPool?.next(domain) ?? undefined
    let t3: Awaited<ReturnType<typeof runTier3>>
    for (let attempt = 0; ; attempt++) {
      const remaining3 = maxTimeout - (Date.now() - totalStart)
      t3 = await runTier3(req.url, handle, remaining3, proxy3, sanitizedHeaders, req.method, req.body)

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
      if (cookies.length > 0) {
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
      }
    }

    if (maxTier < 4) {
      throw new ScrapeError("Max tier reached without success", timings)
    }

    // Tier 4: residential proxy escalation — requires at least one residential proxy,
    // supplied either per-request (req.proxy) or via the configured residential pool.
    let proxy4 = req.proxy ?? deps.residentialProxyPool?.next(domain)
    if (!proxy4) {
      throw new ScrapeError(
        `Tier 3 failed (${t3.reason ?? t3.status}). Set RESIDENTIAL_PROXY_URL (or pass a proxy per-request) to enable Tier 4 proxy escalation.`,
        timings,
      )
    }

    let t4: Awaited<ReturnType<typeof runTier4>>
    const { runTier4: runTier4Lazy } = await import("./tiers/4")
    for (let attempt = 0; ; attempt++) {
      console.log(`[orchestrator] Tier 4 via residential proxy: ${proxy4.replace(/\/\/[^@]*@/, "//**@")}`)
      const remaining4 = maxTimeout - (Date.now() - totalStart)
      t4 = await runTier4Lazy(req.url, handle, remaining4, proxy4, sanitizedHeaders, req.method, req.body)

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
      if (cookies.length > 0) {
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
      }
    }

    throw new ScrapeError(`All tiers exhausted. Last failure: ${t4.reason ?? t4.status}`, timings)
  } finally {
    deps.releaseBrowser(handle.id, handle.lease)
  }
}
