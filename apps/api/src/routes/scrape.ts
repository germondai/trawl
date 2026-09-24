import { PoolExhaustedError } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { RequestValidationError, ScrapeError, sanitizeHeaders, scrape } from "@trawl/tiers"
import type { ScrapeRequest } from "@trawl/types"
import { Elysia } from "elysia"
import { flareSolverrError } from "../adapters/flaresolverr"
import { getDeps, getPool } from "../deps"
import { runLoggedScrape } from "../requestLogging"
import { requestUrl, validateScrapeRequest } from "../validation"

// Native TRAWL API — richer response (tier, timings, sessionCached).
// Error mapping:
//   503 — pool still initializing (native { error })
//   429 — pool exhausted (FlareSolverr envelope; uniform with /v1)
//   500 — other scrape exception (native { error, timings, blockedEvidence })
export function scrapeRoute(deps: () => OrchestratorDeps = getDeps, poolReady: () => unknown = getPool) {
  return new Elysia().post("/scrape", async ({ body, set }) => {
    try {
      validateScrapeRequest(body)
      const req: ScrapeRequest = body
      if (!poolReady()) {
        set.status = 503
        return { error: "Browser pool initializing, retry in a few seconds" }
      }
      return await runLoggedScrape("native", { ...req, headers: sanitizeHeaders(req.headers) }, deps(), scrape)
    } catch (err) {
      if (err instanceof RequestValidationError) {
        set.status = err.statusCode
        return { error: err.message }
      }
      if (err instanceof PoolExhaustedError) {
        set.status = 429
        return flareSolverrError(requestUrl(body), "Browser pool saturated, retry shortly")
      }
      set.status = 500
      if (err instanceof ScrapeError) {
        return {
          error: err.message,
          timings: err.timings,
          ...(err.blockedEvidence ? { blockedEvidence: err.blockedEvidence } : {}),
        }
      }
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
