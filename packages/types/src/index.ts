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

// CONNECT is intentionally excluded — it's a tunneling verb, not a normal
// request body, and would let a caller establish arbitrary TCP tunnels.
// QUERY (RFC 9341) is included — safe verb, body carries the query params.
// Single source of truth for the request-method union — @trawl/tiers derives its
// runtime SUPPORTED_METHODS array from this same literal set (see sanitize.ts).
export type SupportedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE" | "QUERY"

export interface ScrapeRequest {
  url: string
  maxTimeout?: number
  skipHttp?: boolean
  maxTier?: 1 | 2 | 3 | 4
  sessionId?: string
  headers?: Record<string, string>
  method?: SupportedMethod
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
  proxyUsed?: boolean // true if the winning tier routed through a proxy (Tier 3 datacenter pool or Tier 4 residential pool/override)
}

export interface SessionData {
  cookies: Cookie[]
  userAgent: string
  savedAt: number
}

export interface PoolBrowser {
  id: number
  busy: boolean
  // When the current checkout started, or undefined when idle. Used to tell a browser
  // that is busy doing work from one whose request wedged and left it busy forever.
  busySince?: number
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
  // Subset of `busy` that has been checked out longer than the pool's stall threshold.
  // A stalled entry is counted in `busy` but is not real capacity — its request wedged
  // and will never call release(). `live` is the honest capacity number.
  stalled: number
  live: number
}

// Per-instance HTTP-level fingerprint (User-Agent + matching navigator.platform /
// locale / timezone) — @trawl/browser's FINGERPRINT_POOL is typed against this shape.
export interface BrowserFingerprint {
  userAgent: string
  platform: "Win32" | "MacIntel" | "Linux x86_64" | "Linux armv8"
  locale: string
  timezone: string
}

// A leased browser+context pair handed to a tier by @trawl/browser's BrowserPool.
// `context`/`browser` are `any` — camoufox-js doesn't export Playwright's
// Browser/BrowserContext types, and browsers from Playwright vs patchright aren't
// structurally assignable to each other, so `any` is the pragmatic escape hatch
// (consumers call .newPage()/.newContext()/.cookies() etc directly on these fields).
export interface BrowserHandle {
  id: number
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  context: any
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  browser: any
  fingerprint: BrowserFingerprint
  noteTemporaryContext?: (reason: string) => void
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
