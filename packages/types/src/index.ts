export interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}

export interface ScrapeRequest {
  url: string
  maxTimeout?: number
  skipHttp?: boolean
  maxTier?: 1 | 2 | 3 | 4
  sessionId?: string
  headers?: Record<string, string>
  // CONNECT is intentionally excluded — it's a tunneling verb, not a normal
  // request body, and would let a caller establish arbitrary TCP tunnels.
  // QUERY (RFC 9341) is included — safe verb, body carries the query params.
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE" | "QUERY"
  body?: string
  // Per-request proxy override — bypasses the server-configured proxy pool for this call.
  proxy?: string
}

export interface TierResult {
  tier: 1 | 2 | 3 | 4
  status: "success" | "blocked" | "needs-js" | "timeout" | "error" | "skipped"
  durationMs: number
  reason?: string
}

export interface ScrapeResult {
  url: string
  html: string
  cookies: Cookie[]
  userAgent: string
  statusCode: number
  tier: 1 | 2 | 3 | 4
  sessionCached: boolean
  timings: TierResult[]
  totalMs: number
  captchasSolved?: string[] // captcha types solved during this request (e.g. ['turnstile', 'recaptcha-v2'])
}

export interface SessionData {
  cookies: Cookie[]
  userAgent: string
  savedAt: number
}

export interface PoolBrowser {
  id: number
  busy: boolean
  lastDomain?: string
  lastUsedAt?: number
  restartCount: number
  healthy: boolean
}

export interface PoolStats {
  total: number
  busy: number
  available: number
  restarts: number
  avgRestarts: number
}

// Per-request proxy override as it arrives at the API. Prowlarr's Cardigann flow
// serializes this as an object (its FlareSolverrProxy class: {url, username, password}).
// Other callers may send a plain URL string. The API boundary normalizes both forms
// into a single URL string before handing off to the orchestrator.
export type ProxyEndpointInput = string | { url?: string; server?: string; username?: string; password?: string }

export interface FlareSolverrRequest {
  cmd?: "request.get" | "request.post"
  url: string
  maxTimeout?: number
  postData?: string
  headers?: Record<string, string>
  // TRAWL extension (not part of the FlareSolverr v2 contract) — per-request proxy override.
  // Accepts Prowlarr's {url, username, password} object shape OR a plain URL string.
  proxy?: ProxyEndpointInput
}

export interface FlareSolverrResponse {
  status: "ok" | "error"
  message: string
  startTimestamp: number
  endTimestamp: number
  version: "2.0.0"
  solution: {
    url: string
    status: number
    headers: Record<string, string>
    response: string
    cookies: Cookie[]
    userAgent: string
  }
}
