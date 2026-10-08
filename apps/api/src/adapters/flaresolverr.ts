import type { SupportedMethod } from "@trawl/tiers"
import { normalizeInputCookies, normalizeProxy, requireContentTypeForBody, sanitizeHeaders } from "@trawl/tiers"
import type { FlareSolverrResponse, FlareSolverrScrapeRequest, ScrapeRequest } from "@trawl/types"

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
    skipHttp: req.returnScreenshot || req.returnOnlyCookies || Boolean(req.cookies?.length),
    maxTimeout: req.maxTimeout ?? 60_000,
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
