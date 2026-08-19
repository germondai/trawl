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
  // Strict per-request route: target traffic must use this proxy and never fall back direct.
  proxy?: string
  // Opt-in viewport screenshot from the browser tiers (2-4), returned as
  // `ScrapeResult.screenshot`. Off by default — it costs a settle wait and payload
  // size. Tier 1 is a plain HTTP fetch and never produces one.
  screenshot?: boolean
  // Opt-in browser console capture from the browser tiers (2-4), returned as
  // `ScrapeResult.consoleLogs`. Off by default — no listener is attached without it.
  consoleLogs?: boolean
  // Opt-in per-request resource timings from the browser tiers (2-4), returned as
  // `ScrapeResult.networkLogs`. Off by default — no listener is attached without it.
  networkLogs?: boolean
  // Opt-in main-document redirect chain from the browser tiers (2-4), returned as
  // `ScrapeResult.redirectChain`. Off by default.
  redirectChain?: boolean
  // Opt-in response-body capture from the browser tiers (2-4), returned as
  // `ScrapeResult.capturedResponses`. Each entry is a URL substring, or a glob matched
  // against the whole URL when it contains `*` or `?`. Off by default — no listener is
  // attached without it.
  captureResponses?: string[]
  // How long (milliseconds) to hold the page open after load waiting for a match. Ends
  // early on the first captured body, on `waitForSelector`, or on network idle. Only
  // meaningful alongside `captureResponses`.
  settleTimeout?: number
  // CSS selector that also ends the settle window early. Only meaningful alongside
  // `captureResponses`.
  waitForSelector?: string
}

// One browser console message. Shaped after WebDriver's browser log so a consumer can
// treat both sources alike: `level` is the severity vocabulary (SEVERE/WARNING/INFO/
// DEBUG), `source` the console type that produced it, `timestamp` epoch milliseconds.
export interface ConsoleLogEntry {
  level: "SEVERE" | "WARNING" | "INFO" | "DEBUG"
  message: string
  timestamp: number
  source: string
}

// One request's resource timing, shaped after PerformanceResourceTiming: `name` is the
// URL, `startTime` is milliseconds since the capture attached, `duration` milliseconds
// from request start to the last byte (0 for a request that never completed). Sizes are
// null until the browser reports them; `decodedBodySize` stays null because knowing it
// would mean reading every response body.
export interface NetworkLogEntry {
  name: string
  entryType: "navigation" | "resource"
  startTime: number
  duration: number
  initiatorType: string
  transferSize: number | null
  encodedBodySize: number | null
  decodedBodySize: number | null
}

// One response whose URL matched a caller-supplied `captureResponses` pattern. `body` is
// the response payload as text, or base64 when the content type is binary or unknown
// (`base64Encoded`); it is `null` when the body could not be read, in which case `error`
// says why. `truncated` marks a body trimmed to the configured byte budget.
export interface CapturedResponseEntry {
  url: string
  status: number
  headers: Record<string, string>
  body: string | null
  base64Encoded: boolean
  truncated: boolean
  error?: string
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
  proxyUsed?: boolean // true if the winning tier routed through a proxy (Tier 1, 3, or 4)
  // Raw response payload — populated by all tiers when available. The MITM proxy
  // (:8192) consumes this; /scrape and FlareSolverr /v1 still rely on `html` only.
  // Binary content (images, .torrent, videos) MUST use this field — `html` would
  // corrupt non-UTF8 bytes via normalizeHtml().
  body?: Uint8Array
  // Upstream response headers (lowercased keys), preserved verbatim so the proxy
  // can forward Set-Cookie, Content-Disposition, Content-Range, cache validators, etc.
  responseHeaders?: Record<string, string>
  // Convenience: extracted Content-Type header. Same as responseHeaders['content-type'].
  contentType?: string
  // Base64 JPEG of the viewport, present only when the request asked for it and a
  // browser tier served the page. No `data:` prefix.
  screenshot?: string
  // Browser console messages, in the order the page logged them. Present (possibly
  // empty) only when the request asked for them and a browser tier served the page.
  consoleLogs?: ConsoleLogEntry[]
  // Resource timings for the requests the page made, in completion order. Same
  // presence rules as `consoleLogs`.
  networkLogs?: NetworkLogEntry[]
  // URLs the main document walked, in order, first entry being the requested URL.
  // Same presence rules as `consoleLogs`.
  redirectChain?: string[]
  // Bodies of the responses whose URL matched `captureResponses`, in arrival order.
  // Present (possibly empty, meaning nothing matched) only when the request asked for
  // capture and a browser tier served the page.
  capturedResponses?: CapturedResponseEntry[]
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
  /** Whether this lease belongs to a browser running behind a virtual display. */
  headful: boolean
  // Identifies this specific checkout. Pass it back to release() so a request that
  // outlived its checkout can't free a browser the pool has since reclaimed.
  lease: number
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  context: any
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  browser: any
  fingerprint: BrowserFingerprint
  noteTemporaryContext?: () => void
  requestBrowserReplacement?: (reason: string) => void
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
