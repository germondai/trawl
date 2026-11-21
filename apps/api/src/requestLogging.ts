import { PoolExhaustedError } from "@trawl/browser"
import { type OrchestratorDeps, RequestValidationError, ScrapeError, scrape, traceStage } from "@trawl/tiers"
import type {
  CapturedRequest,
  ExecutionStage,
  ScrapeRequest,
  ScrapeResult,
  TierResult,
  WafDetection,
} from "@trawl/types"
import { browserObservations } from "./browserInspectorState"
import type { CaptureStore } from "./captureStore"
import { captures, historyScreenshotLimits } from "./captures"
import { applyDomainProfile, refreshDomainProfile } from "./domainProfile"
import { createHistoryCapture } from "./historyCapture"
import { log, requestId, safeMessage, safeUrl } from "./logger"
import { type MetricsStore, metrics } from "./metrics"
import { requestDiagnostics } from "./requestDiagnostics"

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
  observation?: () => void,
  captureStore: CaptureStore | undefined = captures,
  retainCapture?: (result?: ScrapeResult) => boolean,
  requestContext?: Pick<CapturedRequest, "parameters" | "bodyEncoding"> & {
    operation: "scrape" | "read" | "extract"
  } & { requestReason?: string },
): Promise<ScrapeResult> {
  const started = Date.now()
  const stages: ExecutionStage[] = []
  const context = { startedAt: new Date(started).toISOString(), stages, operation: requestContext?.operation }
  const observeStage = (stage: ExecutionStage) => {
    if (stages.length < 32) stages.push(stage)
    try {
      deps.onStage?.(stage)
    } catch {}
  }
  const profiledReq = applyDomainProfile(req)
  const captured = captureStore?.enabled
    ? createHistoryCapture(captureStore, req, historyScreenshotLimits, {
        source,
        operation: requestContext?.operation ?? "scrape",
        parameters: requestContext?.parameters ?? (req as unknown as Record<string, unknown>),
        bodyEncoding: requestContext?.bodyEncoding,
        requestReason: requestContext?.requestReason,
      })
    : undefined

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

  const detectWaf = deps.detectWaf
  const originalAttempt = deps.onTierAttempt
  const observations = browserObservations
  const tracedDeps: OrchestratorDeps = {
    ...deps,
    requestId: id,
    onStage: observeStage,
    acquireBrowser: (...args) => traceStage("browser-acquire", () => deps.acquireBrowser(...args), observeStage),
    loadSession: (...args) => traceStage("session-cache", () => deps.loadSession(...args), observeStage),
    ...(detectWaf
      ? {
          detectWaf: (...args: Parameters<NonNullable<OrchestratorDeps["detectWaf"]>>) =>
            traceStage("waf-detection", () => detectWaf(...args), observeStage),
        }
      : {}),
    ...(observations
      ? {
          observePage: (page, tier, browser, remaining) => {
            let original: (() => void) | undefined
            try {
              original = deps.observePage?.(page, tier, browser, remaining)
            } catch {}
            const stop = observations.register(page, {
              requestId: id,
              sessionId: req.sessionId,
              source,
              tier,
              browserId: browser.id,
              headful: browser.headful,
              remaining,
            })
            return () => {
              try {
                stop()
              } finally {
                original?.()
              }
            }
          },
        }
      : {}),
    ...(captured?.observe
      ? {
          captureHistory: async (page, tier, budgetMs, shot) => {
            const start = Date.now()
            await deps.captureHistory?.(page, tier, budgetMs, shot)
            await captured.observe?.(page, tier, Math.max(0, budgetMs - (Date.now() - start)), shot)
          },
        }
      : {}),
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

  const finish = observation ?? metricsStore.startRequest(id, source, req.url, req.method ?? "GET")
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
      requestId: id,
      method: req.method ?? "GET",
      source,
      url: req.url,
      durationMs: Date.now() - started,
      tier: result.tier,
      attempts: result.timings,
      statusCode: result.statusCode,
      waf,
      challenge: result.captchasSolved?.[0],
      diagnostics: requestDiagnostics(req, result, [], undefined, context),
    })
    if (captured) {
      try {
        const entry = metricsStore.request(id)
        if (entry && retainCapture?.(result) !== false) captured.commit(id, entry.at, result)
      } catch {
        /* Optional artifacts must not change the response or request accounting. */
      }
    }
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
      requestId: id,
      method: req.method ?? "GET",
      source,
      url: req.url,
      durationMs: Date.now() - started,
      error,
      diagnostics: requestDiagnostics(
        req,
        undefined,
        error instanceof ScrapeError ? error.timings : [],
        error instanceof ScrapeError ? error.blockedEvidence?.reason : undefined,
        { ...context, error },
      ),
      waf,
      challenge:
        error instanceof ScrapeError
          ? (error.blockedEvidence?.reason ?? error.timings.find((attempt) => attempt.status === "blocked")?.reason)
          : undefined,
      ...(error instanceof RequestValidationError ? { statusCode: error.statusCode } : {}),
    })
    if (captured) {
      try {
        const entry = metricsStore.request(id)
        if (entry && retainCapture?.() !== false)
          captured.failed(id, entry.at, error instanceof ScrapeError ? error.blockedEvidence : undefined)
      } catch {
        /* Retained failure evidence is optional, just like successful captures. */
      }
    }
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
  } finally {
    captured?.dispose()
    finish?.()
  }
}
