import type { SupportedMethod } from "@trawl/tiers"
import { normalizeProxy, requireContentTypeForBody, sanitizeHeaders } from "@trawl/tiers"
import type { FlareSolverrRequest, FlareSolverrResponse, ScrapeRequest } from "@trawl/types"

export function buildScrapeRequestFromFlareSolverr(req: FlareSolverrRequest): ScrapeRequest {
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
