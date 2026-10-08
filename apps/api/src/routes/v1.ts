import { PoolExhaustedError } from "@trawl/browser"
import { normalizeProxy, RequestValidationError, scrape, validateSessionId } from "@trawl/tiers"
import type { FlareSolverrRequest, FlareSolverrResponse, FlareSolverrScrapeRequest } from "@trawl/types"
import { Elysia } from "elysia"
import { buildScrapeRequestFromFlareSolverr, flareSolverrError } from "../adapters/flaresolverr"
import { getDeps, getPool } from "../deps"
import { type MetricsStore, metrics } from "../metrics"
import { runLoggedScrape } from "../requestLogging"
import { requestUrl, validateFlareSolverrRequest } from "../validation"

// FlareSolverr v2 compat — always open (the v2 spec has no auth header)
interface V1RouteOptions {
  runScrape?: typeof scrape
  poolReady?: () => boolean
  orchestratorDeps?: typeof getDeps
  metricsStore?: MetricsStore
}

export function v1Route({
  runScrape = scrape,
  poolReady = () => Boolean(getPool()),
  orchestratorDeps = getDeps,
  metricsStore = metrics,
}: V1RouteOptions = {}) {
  return new Elysia().post("/v1", async ({ body, set }) => {
    const startTimestamp = Date.now()
    let scraperStarted = false
    const command = typeof body === "object" && body !== null && "cmd" in body ? body.cmd : undefined
    const sessionCommand =
      command === "sessions.create" || command === "sessions.list" || command === "sessions.destroy"

    try {
      validateFlareSolverrRequest(body)
      const req: FlareSolverrRequest = body
      const cmd = req.cmd ?? "request.get"

      if (!["request.get", "request.post", "sessions.create", "sessions.list", "sessions.destroy"].includes(cmd)) {
        set.status = 400
        metricsStore.record({
          source: "flaresolverr",
          url: requestUrl(req),
          durationMs: Date.now() - startTimestamp,
          statusCode: 400,
        })
        return flareSolverrError(requestUrl(req), `Unknown cmd: ${cmd}`)
      }

      if (!poolReady()) {
        set.status = 503
        if (!sessionCommand)
          metricsStore.record({
            source: "flaresolverr",
            url: requestUrl(req),
            durationMs: Date.now() - startTimestamp,
            statusCode: 503,
          })
        return flareSolverrError(requestUrl(req), "Browser pool initializing, retry in a few seconds")
      }

      if (cmd.startsWith("sessions.")) {
        const sessions = orchestratorDeps().sessions
        if (!sessions) throw new RequestValidationError("Browser sessions are unavailable", 503)
        const envelope = { status: "ok", message: "", startTimestamp, endTimestamp: Date.now(), version: "2.0.0" }
        if (cmd === "sessions.create") {
          if (req.proxy !== undefined && !normalizeProxy(req.proxy))
            throw new RequestValidationError("Invalid session proxy", 400)
          const created = await sessions.create({ id: req.session, proxy: normalizeProxy(req.proxy) }, true)
          return { ...envelope, message: "Session is ready.", endTimestamp: Date.now(), session: created.id }
        }
        if (cmd === "sessions.list")
          return { ...envelope, sessions: (await sessions.list()).map((session) => session.id) }
        validateSessionId(req.session)
        await sessions.destroy(req.session)
        return { ...envelope, message: "The session has been removed.", endTimestamp: Date.now() }
      }

      const scrapeRequest = buildScrapeRequestFromFlareSolverr(req as FlareSolverrScrapeRequest)
      const deps = orchestratorDeps()
      const scrapeReq = req as FlareSolverrScrapeRequest
      if (scrapeReq.session) {
        if (!deps.sessions) throw new RequestValidationError("Browser sessions are unavailable", 503)
        await deps.sessions.ensure(
          scrapeReq.session,
          scrapeReq.session_ttl_minutes ? scrapeReq.session_ttl_minutes * 60_000 : undefined,
        )
      }
      scraperStarted = true
      const result = await runLoggedScrape("flaresolverr", scrapeRequest, deps, runScrape, undefined, metricsStore)
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
          ...(!scrapeReq.returnOnlyCookies ? { response: result.html } : {}),
          ...(scrapeReq.returnScreenshot ? { screenshot: result.screenshot } : {}),
          cookies: result.cookies,
          userAgent: result.userAgent,
        },
      } satisfies FlareSolverrResponse
    } catch (err) {
      if (err instanceof RequestValidationError) {
        set.status = err.statusCode
        if (!scraperStarted && !sessionCommand)
          metricsStore.record({
            source: "flaresolverr",
            url: requestUrl(body),
            durationMs: Date.now() - startTimestamp,
            statusCode: err.statusCode,
            error: err,
          })
        return flareSolverrError(requestUrl(body), err.message)
      }
      set.status = err instanceof PoolExhaustedError ? 429 : 500
      if (!scraperStarted && !sessionCommand)
        metricsStore.record({
          source: "flaresolverr",
          url: requestUrl(body),
          durationMs: Date.now() - startTimestamp,
          statusCode: err instanceof PoolExhaustedError ? 429 : 500,
          error: err,
        })
      return flareSolverrError(requestUrl(body), err instanceof Error ? err.message : String(err))
    }
  })
}
