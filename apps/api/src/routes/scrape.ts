import { PoolExhaustedError } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { RequestValidationError, ScrapeError, sanitizeHeaders, scrape, validateSessionId } from "@trawl/tiers"
import type { ExtractResponse, ReadResponse, ScrapeRequest } from "@trawl/types"
import { type Context, Elysia } from "elysia"
import { flareSolverrError } from "../adapters/flaresolverr"
import type { CaptureStore } from "../captureStore"
import { captures } from "../captures"
import { getDeps, getPool } from "../deps"
import { requestId } from "../logger"
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
  captureStore: CaptureStore | undefined = captures,
) {
  const handle = async (
    body: unknown,
    set: Context["set"],
    sessionId?: string,
    operation?: "read" | "extract",
    proposedId: string | null = null,
  ) => {
    const started = Date.now()
    // No await occurs before the existing observation starts or this result is recorded.
    const id = metricsStore.acceptRequestId(proposedId) ?? requestId()
    set.headers["X-Trawl-Request-ID"] = id
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
        metricsStore.record({
          requestId: id,
          source: "native",
          url: req.url,
          durationMs: Date.now() - started,
          statusCode: 503,
        })
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
        id,
        metricsStore,
        page
          ? (result) => {
              output = page.format(result)
            }
          : undefined,
        undefined,
        captureStore,
        undefined,
        {
          operation: operation ?? "scrape",
          parameters: sessionId === undefined ? (body as unknown as Record<string, unknown>) : { ...body, sessionId },
        },
      )
      return { ...(output ?? result), requestId: id }
    } catch (err) {
      if (err instanceof RequestValidationError) {
        set.status = err.statusCode
        if (!scraperStarted)
          metricsStore.record({
            requestId: id,
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
            requestId: id,
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
          requestId: id,
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
    .post("/scrape", ({ body, set, request }) =>
      handle(body, set, undefined, undefined, request.headers.get("x-trawl-request-id")),
    )
    .post("/read", ({ body, set, request }) =>
      handle(body, set, undefined, "read", request.headers.get("x-trawl-request-id")),
    )
    .post("/extract", ({ body, set, request }) =>
      handle(body, set, undefined, "extract", request.headers.get("x-trawl-request-id")),
    )
    .post("/sessions/:id/scrape", ({ params, body, set }) => handle(body, set, params.id))
}
