import { PoolExhaustedError } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { RequestValidationError, ScrapeError, sanitizeHeaders, scrape, validateSessionId } from "@trawl/tiers"
import type { ExtractResponse, ReadResponse, ScrapeRequest } from "@trawl/types"
import { type Context, Elysia } from "elysia"
import { flareSolverrError } from "../adapters/flaresolverr"
import { getDeps, getPool } from "../deps"
import { type MetricsStore, metrics } from "../metrics"
import { preparePageOperation } from "../pageContent/options"
import { runLoggedScrape } from "../requestLogging"
import { requestUrl, validateScrapeRequest } from "../validation"

// Native TRAWL API - richer response (tier, timings, sessionCached).
// Error mapping:
//   503 - pool still initializing (native { error })
//   429 - pool exhausted (FlareSolverr envelope; uniform with /v1)
//   500 - other scrape exception (native { error, timings, blockedEvidence })
export function scrapeRoute(
  deps: () => OrchestratorDeps = getDeps,
  poolReady: () => unknown = getPool,
  metricsStore: MetricsStore = metrics,
) {
  const handle = async (body: unknown, set: Context["set"], sessionId?: string, operation?: "read" | "extract") => {
    const started = Date.now()
    let scraperStarted = false
    try {
      validateScrapeRequest(body)
      const page = operation ? preparePageOperation(operation, body) : undefined
      if (sessionId !== undefined) {
        validateSessionId(sessionId)
        if (body.sessionId !== undefined && body.sessionId !== sessionId)
          throw new RequestValidationError("sessionId must match the session ID in the URL", 400)
      }
      const req: ScrapeRequest = sessionId === undefined ? (page?.request ?? body) : { ...body, sessionId }
      if (!poolReady()) {
        set.status = 503
        metricsStore.record({ source: "native", url: req.url, durationMs: Date.now() - started, statusCode: 503 })
        return { error: "Browser pool initializing, retry in a few seconds" }
      }
      const sanitized = { ...req, headers: sanitizeHeaders(req.headers) }
      const orchestratorDeps = deps()
      scraperStarted = true
      let output: ReadResponse | ExtractResponse | undefined
      const result = await runLoggedScrape(
        "native",
        sanitized,
        orchestratorDeps,
        scrape,
        undefined,
        metricsStore,
        page
          ? (result) => {
              output = page.format(result)
            }
          : undefined,
      )
      return output ?? result
    } catch (err) {
      if (err instanceof RequestValidationError) {
        set.status = err.statusCode
        if (!scraperStarted)
          metricsStore.record({
            source: "native",
            url: requestUrl(body),
            durationMs: Date.now() - started,
            statusCode: err.statusCode,
            error: err,
          })
        return { error: err.message }
      }
      if (err instanceof PoolExhaustedError) {
        set.status = 429
        if (!scraperStarted)
          metricsStore.record({
            source: "native",
            url: requestUrl(body),
            durationMs: Date.now() - started,
            statusCode: 429,
            error: err,
          })
        return flareSolverrError(requestUrl(body), "Browser pool saturated, retry shortly")
      }
      set.status = 500
      if (!scraperStarted)
        metricsStore.record({
          source: "native",
          url: requestUrl(body),
          durationMs: Date.now() - started,
          statusCode: 500,
          error: err,
        })
      if (err instanceof ScrapeError) {
        return {
          error: err.message,
          timings: err.timings,
          ...(err.blockedEvidence ? { blockedEvidence: err.blockedEvidence } : {}),
          ...(err.waf ? { waf: err.waf } : {}),
          ...(err.captchaDiagnostics?.length ? { captchaDiagnostics: err.captchaDiagnostics } : {}),
        }
      }
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
  return new Elysia()
    .post("/scrape", ({ body, set }) => handle(body, set))
    .post("/read", ({ body, set }) => handle(body, set, undefined, "read"))
    .post("/extract", ({ body, set }) => handle(body, set, undefined, "extract"))
    .post("/sessions/:id/scrape", ({ params, body, set }) => handle(body, set, params.id))
}
