import type { OrchestratorDeps, SupportedMethod, scrape } from "@trawl/tiers"
import {
  cookieMatchesUrl,
  normalizeInputCookies,
  normalizeProxy,
  requireContentTypeForBody,
  ScrapeError,
  sanitizeHeaders,
} from "@trawl/tiers"
import type { FlareSolverrResponse, FlareSolverrScrapeRequest, ScrapeRequest, ScrapeResult } from "@trawl/types"
import { log, safeUrl } from "../logger"

export async function scrapeWithCookieFallback(
  req: ScrapeRequest,
  deps: OrchestratorDeps,
  runScrape: typeof scrape,
  id: string,
): Promise<ScrapeResult> {
  const started = Date.now()
  const result = await runScrape(req, deps)
  const target = new URL(req.url)
  const hasCookies = (result: ScrapeResult) =>
    result.cookies.some((cookie) => cookie.name && cookie.value && cookieMatchesUrl(cookie, target))
  if (
    req.method !== "GET" ||
    req.sessionId ||
    req.cookies?.length ||
    result.tier !== 1 ||
    result.statusCode < 200 ||
    result.statusCode >= 300 ||
    hasCookies(result) ||
    // Prowlarr's proxy test checks connectivity, not indexer cookie handoff.
    (target.href === "https://prowlarr.servarr.com/v1/ping" &&
      new URL(result.url).href === target.href &&
      result.html.trim() === "Pong")
  )
    return result

  const remaining = (req.maxTimeout ?? deps.defaultMaxTimeout ?? 60_000) - (Date.now() - started)
  if (remaining <= 0) throw new ScrapeError("Scrape deadline exceeded before cookie handoff fallback", result.timings)
  log("info", "flaresolverr", {
    event: "cookie-handoff.fallback",
    request: id,
    target: safeUrl(req.url),
    reason: "http-success-without-usable-cookies",
  })
  // One fresh browser tier, sharing the HTTP request's remaining deadline.
  const tier = deps.minTier === 4 ? 4 : 3
  let browser: ScrapeResult
  try {
    browser = await runScrape(
      { ...req, skipHttp: true, maxTimeout: remaining, maxTier: tier },
      { ...deps, minTier: tier },
    )
  } catch (error) {
    if (error instanceof ScrapeError) error.timings = [...result.timings, ...error.timings]
    throw error
  }
  const timings = [...result.timings, ...browser.timings]
  if (!hasCookies(browser)) {
    const error = new ScrapeError(
      "Browser returned no usable cookies for the requested URL; cookie handoff is unavailable",
      timings,
      undefined,
      browser.captchaDiagnostics,
    )
    error.waf = browser.waf ?? result.waf
    throw error
  }
  return { ...browser, timings, totalMs: Date.now() - started, waf: browser.waf ?? result.waf }
}

function normalizeProwlarrHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return

  const normalized: Record<string, string> = {}
  let serializedContentType: string | undefined
  let hasStandardContentType = false

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.trim().toLowerCase()
    if (lowerName === "contenttype") {
      serializedContentType ??= value
      continue
    }
    if (lowerName === "contentlength") continue
    if (lowerName === "content-type") hasStandardContentType = true
    normalized[name] = value
  }

  // Prowlarr serializes these HttpHeader properties without HTTP's hyphens.
  // Keep an explicitly supplied standard header authoritative, even if invalid;
  // the normal body validation below will then reject an empty value.
  if (!hasStandardContentType && serializedContentType !== undefined) {
    normalized["Content-Type"] = serializedContentType
  }

  return normalized
}

export function buildScrapeRequestFromFlareSolverr(req: FlareSolverrScrapeRequest): ScrapeRequest {
  const method: SupportedMethod = req.cmd === "request.post" ? "POST" : "GET"
  const headers = sanitizeHeaders(normalizeProwlarrHeaders(req.headers)) ?? {}
  if (method === "POST" && req.postData && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
    headers["Content-Type"] = "application/x-www-form-urlencoded"
  requireContentTypeForBody(headers, Boolean(req.postData))
  if (req.cookies !== undefined) normalizeInputCookies(req.cookies, req.url)
  return {
    url: req.url,
    sessionId: req.session,
    cookies: req.cookies,
    screenshot: req.returnScreenshot,
    solveEmbeddedCaptchas: req.solveEmbeddedCaptchas ?? false,
    skipHttp: req.returnScreenshot || req.returnOnlyCookies || Boolean(req.cookies?.length),
    maxTimeout: req.maxTimeout,
    headers,
    method,
    body: req.postData,
    // Prowlarr's Cardigann flow serializes proxy as {url, username, password};
    // other callers may send a plain URL string. Normalize to a single URL string
    // here so downstream Playwright/Camoufox `newContext({proxy})` calls receive
    // a string (issue #12 - proxy.server: expected string, got object).
    proxy: req.session ? undefined : normalizeProxy(req.proxy),
  }
}

// Build a FlareSolverr v2-shaped error envelope. Used by /v1 for every error
// path and by /scrape when the pool is exhausted (PoolExhaustedError → 429).
export function flareSolverrError(url: string, message: string): FlareSolverrResponse {
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
