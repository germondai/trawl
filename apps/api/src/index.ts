import { BrowserPool, PoolExhaustedError, SessionCache } from "@trawl/browser"
import {
  isValidMethod,
  normalizeProxy,
  ProxyPool,
  RequestValidationError,
  requireContentTypeForBody,
  ScrapeError,
  SUPPORTED_METHODS,
  type SupportedMethod,
  sanitizeHeaders,
  scrape,
} from "@trawl/tiers"
import type { FlareSolverrRequest, FlareSolverrResponse, PoolStats, ScrapeRequest } from "@trawl/types"
import { Elysia } from "elysia"

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
const PORT = Number(process.env.PORT ?? "8191")
const POOL_SIZE = Number(process.env.BROWSER_POOL_SIZE ?? "3")
// How long acquire() will poll for a free browser before rejecting with PoolExhaustedError.
// 15s covers a full CF challenge burst with pool=3 (queue depth 7, slowest finishes at ~12s).
// Tune lower for fast-fail feedback in dev; tune higher for very heavy upstream targets.
const ACQUIRE_TIMEOUT_MS = Number(process.env.BROWSER_ACQUIRE_TIMEOUT_MS ?? "15000")
const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS ?? "3600")
const RECYCLE_AFTER_TEMPORARY_CONTEXTS = Number(process.env.BROWSER_RECYCLE_AFTER_CONTEXTS ?? "8")
// Caps Firefox content processes per browser. Default `2` keeps thread/RAM footprint
// minimal while still allowing CF/Imperva challenges to resolve. Raise if specific
// targets fail with empty content (rare).
const CONTENT_PROCESSES = Number(process.env.BROWSER_CONTENT_PROCESSES ?? "2")

// PROXY_URL / RESIDENTIAL_PROXY_URL accept a comma-separated list of proxy URLs (a single
// URL still works — it's just a 1-element list). *_LIST_FILE is an alternative source
// (one proxy per line) for lists too large for a single env var.
const proxyPool =
  ProxyPool.fromEnv(process.env.PROXY_URL || undefined, process.env.PROXY_LIST_FILE || undefined) ?? undefined
const residentialProxyPool =
  ProxyPool.fromEnv(
    process.env.RESIDENTIAL_PROXY_URL || undefined,
    process.env.RESIDENTIAL_PROXY_LIST_FILE || undefined,
  ) ?? undefined

// Single embedded pool — no BullMQ / worker process required.
// Redis is optional: without it, session caching (Tier 2 fast path) is disabled
// but scraping still works via Tier 1 / Tier 3.
let pool: BrowserPool | null = null
let sessionCache: SessionCache | null = null

async function initPool() {
  try {
    sessionCache = new SessionCache({
      redisUrl: REDIS_URL,
      ttlSeconds: SESSION_TTL,
    })
    console.log("[api] session cache connected  (Tier 2 fast-path enabled)")
  } catch (err) {
    console.warn("[api] session cache unavailable — Tier 2 disabled:", err instanceof Error ? err.message : err)
  }

  pool = new BrowserPool({
    poolSize: POOL_SIZE,
    acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
    contentProcesses: CONTENT_PROCESSES,
  })
  await pool.init()
  pool.startHealthCheck()
  console.log(`[api] ready — all ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"} warm`)
}

function getDeps() {
  if (!pool) throw new Error("pool not ready")
  const p = pool
  const sc = sessionCache
  return {
    acquireBrowser: (d: string) => p.acquire(d),
    releaseBrowser: (id: number) => p.release(id),
    // Session cache ops are no-ops when Redis is unavailable
    loadSession: (d: string) => (sc ? sc.load(d).catch(() => null) : Promise.resolve(null)),
    saveSession: (d: string, data: unknown) => (sc ? sc.save(d, data as never).catch(() => {}) : Promise.resolve()),
    invalidateSession: (d: string) => (sc ? sc.invalidate(d).catch(() => {}) : Promise.resolve()),
    proxyPool,
    residentialProxyPool,
  }
}

function buildScrapeRequestFromFlareSolverr(req: FlareSolverrRequest): ScrapeRequest {
  const method: SupportedMethod = req.cmd === "request.post" ? "POST" : "GET"
  const headers = sanitizeHeaders(req.headers)
  requireContentTypeForBody(headers, Boolean(req.postData))
  return {
    url: req.url,
    maxTimeout: req.maxTimeout ?? 60_000,
    headers,
    method,
    body: req.postData,
    // Prowlarr's Cardigann flow serializes proxy as {url, username, password};
    // other callers may send a plain URL string. Normalize to a single URL string
    // here so downstream Playwright/Camoufox `newContext({proxy})` calls receive
    // a string (issue #12 — proxy.server: expected string, got object).
    proxy: normalizeProxy(req.proxy),
  }
}

function validateScrapeRequest(req: ScrapeRequest): void {
  if (!isValidMethod(req.method)) {
    throw new RequestValidationError(
      `Unsupported method: ${String(req.method)} (allowed: ${SUPPORTED_METHODS.join(", ")})`,
      400,
    )
  }
  requireContentTypeForBody(sanitizeHeaders(req.headers), Boolean(req.body))
}

const startTime = Date.now()

// Build a FlareSolverr v2-shaped error envelope. Used by /v1 for every error
// path and by /scrape when the pool is exhausted (PoolExhaustedError → 429).
function flareSolverrError(url: string, message: string): FlareSolverrResponse {
  const now = Date.now()
  return {
    status: "error",
    message,
    startTimestamp: now,
    endTimestamp: now,
    version: "2.0.0",
    solution: {
      url,
      status: 0,
      headers: {},
      response: "",
      cookies: [],
      userAgent: "",
    },
  }
}

new Elysia()
  .get("/health", ({ set }) => {
    if (!pool) set.status = 503
    return {
      status: pool ? "ok" : "starting",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pool:
        pool?.getStats() ??
        ({
          total: 0,
          busy: 0,
          available: 0,
          restarts: 0,
          avgRestarts: 0,
        } satisfies PoolStats),
    }
  })

  .get("/stats", () => {
    const stats = pool?.getStats() ?? {
      total: 0,
      busy: 0,
      available: 0,
      restarts: 0,
      avgRestarts: 0,
    }
    return {
      browsers: stats.total,
      available: stats.available,
      busy: stats.busy,
      restarts: stats.restarts,
      queueDepth: 0,
    }
  })

  // FlareSolverr v2 compat — always open (Prowlarr/Jackett can't send auth headers)
  .post("/v1", async ({ body, set }) => {
    const req = body as FlareSolverrRequest
    const startTimestamp = Date.now()
    const cmd = req.cmd ?? "request.get"

    if (cmd !== "request.get" && cmd !== "request.post") {
      set.status = 400
      return flareSolverrError(req.url, `Unknown cmd: ${cmd}`)
    }

    if (!pool) {
      set.status = 503
      return flareSolverrError(req.url, "Browser pool initializing, retry in a few seconds")
    }

    try {
      const scrapeRequest = buildScrapeRequestFromFlareSolverr(req)
      const result = await scrape(scrapeRequest, getDeps())
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
        return flareSolverrError(req.url, err.message)
      }
      set.status = err instanceof PoolExhaustedError ? 429 : 500
      return flareSolverrError(req.url, err instanceof Error ? err.message : String(err))
    }
  })

  // Native TRAWL API — richer response (tier, timings, sessionCached).
  // Error mapping:
  //   503 — pool still initializing (native { error })
  //   429 — pool exhausted (FlareSolverr envelope; uniform with /v1)
  //   500 — other scrape exception (native { error })
  .post("/scrape", async ({ body, set }) => {
    if (!pool) {
      set.status = 503
      return { error: "Browser pool initializing, retry in a few seconds" }
    }
    const req = body as ScrapeRequest
    try {
      validateScrapeRequest(req)
      return await scrape({ ...req, headers: sanitizeHeaders(req.headers) }, getDeps())
    } catch (err) {
      if (err instanceof RequestValidationError) {
        set.status = err.statusCode
        return { error: err.message }
      }
      if (err instanceof PoolExhaustedError) {
        set.status = 429
        return flareSolverrError(req.url ?? "", "Browser pool saturated, retry shortly")
      }
      set.status = 500
      if (err instanceof ScrapeError) {
        return { error: err.message, timings: err.timings }
      }
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  .listen(PORT)

console.log(`[api] TRAWL starting on :${PORT}  (pool: ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"})`)
initPool().catch((err) => {
  console.error("[api] startup failed:", err)
  process.exit(1)
})

// Camoufox (Firefox) emits page-error events in a shape playwright-core's dispatcher
// doesn't expect for some target-page JS errors (e.g. missing `error.location`), which
// throws inside the library's own internal event handling — outside any try/catch we
// control, since it fires from a page-level event listener, not from our request path.
// Without this, one target site's malformed error crashes the entire process and drops
// every in-flight request across all clients, not just the one that triggered it.
process.on("uncaughtException", (err) => {
  console.error("[api] uncaughtException (continuing):", err instanceof Error ? err.message : err)
})

process.on("unhandledRejection", (reason) => {
  console.error("[api] unhandledRejection (continuing):", reason instanceof Error ? reason.message : reason)
})

process.on("SIGTERM", async () => {
  await pool?.shutdown()
  process.exit(0)
})

process.on("SIGINT", async () => {
  await pool?.shutdown()
  process.exit(0)
})
