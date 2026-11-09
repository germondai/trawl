import { PoolExhaustedError } from "@trawl/browser"
import { type OrchestratorDeps, RequestValidationError, ScrapeError, scrape } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult, TierResult, WafDetection } from "@trawl/types"
import { applyDomainProfile, refreshDomainProfile } from "./domainProfile"
import { log, requestId, safeMessage, safeUrl } from "./logger"
import { type MetricsStore, metrics } from "./metrics"

export type ScrapeSource = "native" | "flaresolverr" | "mcp" | "proxy"

const wafLogFields = (waf?: WafDetection) => ({
  wafState: waf?.state,
  wafVersion: waf?.version,
  wafProducts: waf?.products.join(", "),
  wafSourceTier: waf?.sourceTier,
  wafDurationMs: waf?.durationMs,
  wafReason: waf?.reason,
  wafIncompleteProducts: waf?.incompleteProducts?.join(", "),
  wafDiagnostics: waf?.diagnostics?.map((item) => item.code).join(", "),
  wafDetailsTruncated: waf?.detailsTruncated,
})

export async function runLoggedScrape(
  source: ScrapeSource,
  req: ScrapeRequest,
  deps: OrchestratorDeps,
  runScrape: typeof scrape = scrape,
  id = requestId(),
  metricsStore: MetricsStore = metrics,
  onResult?: (result: ScrapeResult) => void,
): Promise<ScrapeResult> {
  const started = Date.now()
  const profiledReq = applyDomainProfile(req)

  log("info", "scrape", {
    event: "request.start",
    request: id,
    source,
    method: req.method ?? "GET",
    target: safeUrl(req.url),
    timeoutMs: req.maxTimeout ?? deps.defaultMaxTimeout ?? 60_000,
    maxTier: req.maxTier ?? 4,
    proxy: Boolean(req.proxy),
  })

  const originalAttempt = deps.onTierAttempt
  const tracedDeps: OrchestratorDeps = {
    ...deps,
    onTierAttempt: (attempt: TierResult) => {
      originalAttempt?.(attempt)
      log("info", "scrape", {
        event: "tier.complete",
        request: id,
        tier: attempt.tier,
        status: attempt.status,
        durationMs: attempt.durationMs,
        reason: attempt.reason ? safeMessage(attempt.reason) : undefined,
      })
    },
  }

  let scraped = false
  let waf: WafDetection | undefined
  try {
    const result = await runScrape(profiledReq, tracedDeps)
    waf = result.waf
    scraped = true
    refreshDomainProfile(req, result.timings, {
      resultTier: result.tier,
      sessionCached: result.sessionCached,
    })
    onResult?.(result)
    metricsStore.record({
      source,
      url: req.url,
      durationMs: Date.now() - started,
      tier: result.tier,
      attempts: result.timings,
      statusCode: result.statusCode,
      waf,
    })
    log("info", "scrape", {
      event: "request.success",
      request: id,
      source,
      statusCode: result.statusCode,
      tier: result.tier,
      totalMs: result.totalMs,
      bytes: result.body?.byteLength ?? result.html.length,
      cookies: result.cookies.length,
      sessionCached: result.sessionCached,
      proxyUsed: result.proxyUsed,
      captchas: result.captchasSolved?.join(","),
      ...wafLogFields(waf),
    })
    return result
  } catch (error) {
    if (error instanceof ScrapeError) waf = error.waf
    const last = error instanceof ScrapeError ? error.timings.at(-1) : undefined
    if (!scraped) refreshDomainProfile(req, error instanceof ScrapeError ? error.timings : [], { failure: true })
    metricsStore.record({
      source,
      url: req.url,
      durationMs: Date.now() - started,
      error,
      waf,
      ...(error instanceof RequestValidationError ? { statusCode: error.statusCode } : {}),
    })
    log(error instanceof PoolExhaustedError ? "warn" : "error", "scrape", {
      event: "request.failure",
      request: id,
      source,
      totalMs: Date.now() - started,
      tier: last?.tier,
      status: last?.status,
      reason: safeMessage(error instanceof Error ? error.message : String(error)),
      ...wafLogFields(waf),
    })
    throw error
  }
}
