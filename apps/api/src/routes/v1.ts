import { PoolExhaustedError } from "@trawl/browser"
import { RequestValidationError, scrape } from "@trawl/tiers"
import type { FlareSolverrRequest, FlareSolverrResponse } from "@trawl/types"
import { Elysia } from "elysia"
import { buildScrapeRequestFromFlareSolverr, flareSolverrError } from "../adapters/flaresolverr"
import { getDeps, getPool } from "../deps"
import { runLoggedScrape } from "../requestLogging"
import { requestUrl, validateFlareSolverrRequest } from "../validation"

// FlareSolverr v2 compat — always open (the v2 spec has no auth header)
interface V1RouteOptions {
  runScrape?: typeof scrape
  poolReady?: () => boolean
  orchestratorDeps?: typeof getDeps
}

export function v1Route({
  runScrape = scrape,
  poolReady = () => Boolean(getPool()),
  orchestratorDeps = getDeps,
}: V1RouteOptions = {}) {
  return new Elysia().post("/v1", async ({ body, set }) => {
    const startTimestamp = Date.now()

    try {
      validateFlareSolverrRequest(body)
      const req: FlareSolverrRequest = body
      const cmd = req.cmd ?? "request.get"

      if (cmd !== "request.get" && cmd !== "request.post") {
        set.status = 400
        return flareSolverrError(req.url, `Unknown cmd: ${cmd}`)
      }

      if (!poolReady()) {
        set.status = 503
        return flareSolverrError(req.url, "Browser pool initializing, retry in a few seconds")
      }

      const scrapeRequest = buildScrapeRequestFromFlareSolverr(req)
      const result = await runLoggedScrape("flaresolverr", scrapeRequest, orchestratorDeps(), runScrape)
      return {
        status: "ok",
        message: "",
        startTimestamp,
        endTimestamp: Date.now(),
        version: "2.0.0",
        solution: {
          url: result.url,
          status: result.statusCode,
          headers: {},
          response: result.html,
          cookies: result.cookies,
          userAgent: result.userAgent,
        },
      } satisfies FlareSolverrResponse
    } catch (err) {
      if (err instanceof RequestValidationError) {
        set.status = err.statusCode
        return flareSolverrError(requestUrl(body), err.message)
      }
      set.status = err instanceof PoolExhaustedError ? 429 : 500
      return flareSolverrError(requestUrl(body), err instanceof Error ? err.message : String(err))
    }
  })
}
