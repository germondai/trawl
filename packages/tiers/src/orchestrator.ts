import type { BrowserHandle } from "@trawl/browser"
import { FINGERPRINT } from "@trawl/browser"
import type { Cookie, ScrapeRequest, ScrapeResult, SessionData, TierResult } from "@trawl/types"
import { normalizeHtml } from "./html"
import type { ProxyPool } from "./proxyRotator"
import { requireContentTypeForBody, sanitizeHeaders } from "./sanitize"
import { runTier1 } from "./tier1"
import { runTier2 } from "./tier2"
import { runTier3 } from "./tier3"
import { runTier4 } from "./tier4"

// Bounds how many distinct proxies a single request will try per tier before giving up —
// keeps a long proxy list from blowing the request's maxTimeout budget.
const MAX_PROXY_ATTEMPTS = 2

export interface OrchestratorDeps {
  acquireBrowser(domain: string): Promise<BrowserHandle>
  releaseBrowser(id: number): void
  loadSession(domain: string): Promise<SessionData | null>
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

  // Tier 1: plain HTTP fetch
  if (!req.skipHttp && maxTier >= 1) {
    const t1 = await runTier1(req.url, sanitizedHeaders, req.method, req.body)
    emit(t1)
    if (t1.status === "success" && t1.html !== undefined) {
      return {
        url: req.url,
        html: normalizeHtml(t1.html),
        cookies: [],
        userAgent: FINGERPRINT.userAgent,
        statusCode: t1.statusCode ?? 200,
        tier: 1,
        sessionCached: false,
        timings,
        totalMs: Date.now() - totalStart,
      }
    }
  }

  if (maxTier < 2) {
    throw new Error("Max tier reached without success")
  }

  // Acquire browser for tiers 2-4
  const handle = await deps.acquireBrowser(domain)

  try {
    // Tier 2: browser with cached session
    const session = await deps.loadSession(domain)
    if (session && maxTier >= 2) {
      const remaining = maxTimeout - (Date.now() - totalStart)
      const t2 = await runTier2(req.url, handle, session, remaining, sanitizedHeaders, req.method, req.body)
      emit(t2)
      if (t2.status === "success" && t2.html !== undefined) {
        if (t2.cookies && t2.cookies.length > 0) {
          await deps.saveSession(domain, {
            cookies: t2.cookies,
            userAgent: session.userAgent,
            savedAt: Date.now(),
          })
        }
        return {
          url: req.url,
          html: normalizeHtml(t2.html),
          cookies: t2.cookies ?? [],
          userAgent: session.userAgent,
          statusCode: t2.statusCode ?? 200,
          tier: 2,
          sessionCached: true,
          timings,
          totalMs: Date.now() - totalStart,
          captchasSolved: t2.captchasSolved,
        }
      }
      // Session failed — purge it
      await deps.invalidateSession(domain)
    }

    if (maxTier < 3) {
      throw new Error("Max tier reached without success")
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
    if (t3.status === "success" && t3.html !== undefined) {
      const cookies: Cookie[] = t3.cookies ?? []
      if (cookies.length > 0) {
        await deps.saveSession(domain, {
          cookies,
          userAgent: t3.userAgent ?? FINGERPRINT.userAgent,
          savedAt: Date.now(),
        })
      }
      return {
        url: req.url,
        html: normalizeHtml(t3.html),
        cookies,
        userAgent: t3.userAgent ?? FINGERPRINT.userAgent,
        statusCode: t3.statusCode ?? 200,
        tier: 3,
        sessionCached: false,
        timings,
        totalMs: Date.now() - totalStart,
        captchasSolved: t3.captchasSolved,
      }
    }

    if (maxTier < 4) {
      throw new Error("Max tier reached without success")
    }

    // Tier 4: residential proxy escalation — requires at least one residential proxy,
    // supplied either per-request (req.proxy) or via the configured residential pool.
    let proxy4 = req.proxy ?? deps.residentialProxyPool?.next(domain)
    if (!proxy4) {
      throw new Error(
        `Tier 3 failed (${t3.reason ?? t3.status}). Set RESIDENTIAL_PROXY_URL (or pass a proxy per-request) to enable Tier 4 proxy escalation.`,
      )
    }

    let t4: Awaited<ReturnType<typeof runTier4>>
    for (let attempt = 0; ; attempt++) {
      console.log(`[orchestrator] Tier 4 via residential proxy: ${proxy4.replace(/\/\/[^@]*@/, "//**@")}`)
      const remaining4 = maxTimeout - (Date.now() - totalStart)
      t4 = await runTier4(req.url, handle, remaining4, proxy4, sanitizedHeaders, req.method, req.body)

      const pool = deps.residentialProxyPool
      if (t4.status !== "blocked" || req.proxy || !pool || attempt + 1 >= MAX_PROXY_ATTEMPTS) break
      pool.markBad(proxy4)
      const next = pool.next(domain)
      if (!next || next === proxy4) break
      proxy4 = next
    }
    emit(t4)
    if (t4.status === "success" && t4.html !== undefined) {
      const cookies: Cookie[] = t4.cookies ?? []
      if (cookies.length > 0) {
        await deps.saveSession(domain, {
          cookies,
          userAgent: t4.userAgent ?? FINGERPRINT.userAgent,
          savedAt: Date.now(),
        })
      }
      return {
        url: req.url,
        html: normalizeHtml(t4.html),
        cookies,
        userAgent: t4.userAgent ?? FINGERPRINT.userAgent,
        statusCode: t4.statusCode ?? 200,
        tier: 4,
        sessionCached: false,
        timings,
        totalMs: Date.now() - totalStart,
      }
    }

    throw new Error(`All tiers exhausted. Last failure: ${t4.reason ?? t4.status}`)
  } finally {
    deps.releaseBrowser(handle.id)
  }
}
