import { PoolExhaustedError } from "@trawl/browser"
import { type OrchestratorDeps, ScrapeError, scrape } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult, TierResult } from "@trawl/types"
import { log, requestId, safeMessage, safeUrl } from "./logger"

export type ScrapeSource = "native" | "flaresolverr" | "mcp" | "proxy"

export async function runLoggedScrape(
  source: ScrapeSource,
  req: ScrapeRequest,
  deps: OrchestratorDeps,
  runScrape: typeof scrape = scrape,
  id = requestId(),
): Promise<ScrapeResult> {
  const started = Date.now()
  log("info", "scrape", {
    event: "request.start",
    request: id,
    source,
    method: req.method ?? "GET",
    target: safeUrl(req.url),
    timeoutMs: req.maxTimeout ?? 60_000,
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

  try {
    const result = await runScrape(req, tracedDeps)
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
    })
    return result
  } catch (error) {
    const last = error instanceof ScrapeError ? error.timings.at(-1) : undefined
    log(error instanceof PoolExhaustedError ? "warn" : "error", "scrape", {
      event: "request.failure",
      request: id,
      source,
      totalMs: Date.now() - started,
      tier: last?.tier,
      status: last?.status,
      reason: safeMessage(error instanceof Error ? error.message : String(error)),
    })
    throw error
  }
}
