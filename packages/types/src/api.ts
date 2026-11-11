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

export interface InputCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  expiry?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

// CONNECT is intentionally excluded - it's a tunneling verb, not a normal
// request body, and would let a caller establish arbitrary TCP tunnels.
// QUERY (RFC 9341) is included - safe verb, body carries the query params.
// Single source of truth for the request-method union - @trawl/tiers derives its
// runtime SUPPORTED_METHODS array from this same literal set (see sanitize.ts).
export type SupportedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE" | "QUERY"

export interface ScrapeRequest {
  url: string
  // Offline provider identification from the first retained response; never controls solving.
  detectWaf?: boolean
  maxTimeout?: number
  skipHttp?: boolean
  // Solve embedded form widgets after clearing access challenges. Defaults to true.
  solveEmbeddedCaptchas?: boolean
  maxTier?: 1 | 2 | 3 | 4
  sessionId?: string
  cookies?: InputCookie[]
  headers?: Record<string, string>
  method?: SupportedMethod
  body?: string
  httpReplay?: boolean
  // Strict per-request route: target traffic must use this proxy and never fall back direct.
  proxy?: string
  // Opt-in viewport screenshot from the browser tiers (2-4), returned as
  // `ScrapeResult.screenshot`. Off by default - it costs a settle wait and payload
  // size. Tier 1 is a plain HTTP fetch and never produces one.
  screenshot?: boolean
  // Browser screenshot options. Ignored unless `screenshot` is true.
  screenshotFullPage?: boolean
  screenshotWaitForSelector?: string
  screenshotSelector?: string
  // Browser tiers wait up to 10 seconds for a visible element before reading
  // the final HTML. Independent of response-body capture's waitForSelector.
  contentWaitForSelector?: string
  // Opt-in browser console capture from the browser tiers (2-4), returned as
  // `ScrapeResult.consoleLogs`. Off by default - no listener is attached without it.
  consoleLogs?: boolean
  // Opt-in per-request resource timings from the browser tiers (2-4), returned as
  // `ScrapeResult.networkLogs`. Off by default - no listener is attached without it.
  networkLogs?: boolean
  // Opt-in main-document redirect chain from the browser tiers (2-4), returned as
  // `ScrapeResult.redirectChain`. Off by default.
  redirectChain?: boolean
  // Opt-in response-body capture from the browser tiers (2-4), returned as
  // `ScrapeResult.capturedResponses`. Each entry is a URL substring, or a glob matched
  // against the whole URL when it contains `*` or `?`. Off by default - no listener is
  // attached without it.
  captureResponses?: string[]
  // How long (milliseconds) to hold the page open after load waiting for a match. Ends
  // early on the first captured body, on `waitForSelector`, or on network idle. Only
  // meaningful alongside `captureResponses`.
  settleTimeout?: number
  // CSS selector that also ends the settle window early. Only meaningful alongside
  // `captureResponses`.
  waitForSelector?: string
  // Opt-in evidence from a challenge wall no tier could clear. Costs nothing on a
  // successful scrape: it is only ever attached to the terminal failure (`blockedEvidence`
  // on the 500 body), never to `ScrapeResult`. The image rides along only when
  // `screenshot` is also set.
  blockedEvidence?: boolean
  // Opt-in MHTML archive of the page from the browser tiers (2-4), returned as
  // `ScrapeResult.mhtml`. Assembled from the subresources the response listener observes,
  // not snapshotted by the engine - Firefox has no Page.captureSnapshot. Off by default;
  // only bounded, identity-encoded responses with a declared length are read.
  mhtml?: boolean
  // Opt-in: load the page even when its TLS certificate fails verification (expired,
  // self-signed, issued for another host). Off by default, so every other caller keeps a
  // verified connection. Because an unverified connection no longer proves whose page came
  // back, a landing on a host the requested URL does not demonstrably lead to is refused
  // instead of returned - see `certificateError` and the crossed-landing guard in
  // @trawl/tiers.
  ignoreCertificateErrors?: boolean
  // Follow bounded HTTP(S) meta refresh redirects, escalating HTML forwarders to a browser.
  followMetaRefresh?: boolean
  // Return a browser-tier page under 100 characters instead of failing it as empty
  // content. Off by default; the network-error and challenge checks still apply.
  allowShortContent?: boolean
  // Opt-in favicon collection from the browser tiers (2-4), returned as
  // `ScrapeResult.favicons`. The apex `/favicon.ico` and every declared
  // `<link rel~="icon">` are fetched from inside the page, so they carry the origin's
  // cookies and the session's challenge clearance. Off by default: it costs one request
  // per icon.
  favicons?: boolean
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

// One of the page's favicons, fetched from inside the page. `data` is base64 with no
// `data:` prefix and is absent when the icon could not be read, in which case `error`
// says why - "no icon there" and "we could not fetch it" are different answers, and
// collapsing them is what hides a favicon the site serves but the scraper never gets.
// `url` is the absolute icon URL, or `data:<mime>` for an inline icon.
export interface FaviconEntry {
  url: string
  contentType?: string
  data?: string
  error?: string
}

// The challenge wall a scrape stopped at, from the last browser tier that rendered one.
// Returned only on the failure path (`blockedEvidence` on the 500 body) and only when the
// request asked for it - a blocked outcome is never dressed up as a successful result.
export interface BlockedEvidence {
  tier: 2 | 3 | 4
  status: "blocked" | "timeout"
  // Same string as the matching `timings[].reason`, e.g. "cloudflare-persistent".
  reason?: string
  // Where the browser actually stood when it gave up, after any challenge redirects.
  url: string
  statusCode?: number
  html: string
  // The wall's markup exceeded BLOCKED_EVIDENCE_MAX_HTML_CHARS and `html` is the head of it.
  htmlTruncated?: boolean
  // Base64 JPEG, present only when the request also asked for a `screenshot`.
  screenshot?: string
}

export interface TierResult {
  tier: 1 | 2 | 3 | 4
  status: "success" | "blocked" | "needs-js" | "timeout" | "error" | "skipped"
  durationMs: number
  reason?: string
}

export interface WafDetection {
  engine: "wafmeow"
  version: string
  state: "complete" | "incomplete" | "unavailable"
  products: string[]
  matches?: {
    product: string
    schema: number
    fingerprints: { fingerprint: number; evidence: number }[]
  }[]
  incompleteProducts?: string[]
  diagnostics?: {
    code: "body_truncated" | "missing_response" | "invalid_engine" | "invalid_evidence" | "transport_error"
    evidence: number
  }[]
  detailsTruncated?: boolean
  sourceTier?: 1 | 2 | 3 | 4
  durationMs?: number
  reason?: "not-installed" | "timeout" | "busy" | "failed" | "no-response"
}

export interface ScrapeResponse {
  waf?: WafDetection
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
  captchaDiagnostics?: { kind: string; status: string }[]
  proxyUsed?: boolean // true if the winning tier routed through a proxy
  // JSON representation of the navigation bytes returned by the native API.
  body?: Record<string, number>
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
  // Multipart/related archive of a successful HTML page: the rendered document first,
  // then safely readable CSS, script, image and font subresources observed loading. Same
  // presence rules as `consoleLogs`. An approximation of browser "Save as MHTML", not a
  // byte-faithful snapshot; omissions are counted inside the archive.
  mhtml?: string
  // Why a Tier 1 TLS hop's certificate failed verification when `ignoreCertificateErrors`
  // was set and the page was served anyway (e.g. "self-signed certificate"). Absent when
  // every observed certificate verified, when the caller did not opt in, and when no
  // verified attempt was made (`skipHttp`) - absence is "not observed", not proof that the
  // certificate was valid.
  certificateError?: string
  // The page's favicons, apex `/favicon.ico` first and then the declared icons in
  // document order. Present (possibly empty) only when the request asked for them and a
  // browser tier served the page.
  favicons?: FaviconEntry[]
}

export interface PageMetadata {
  waf?: WafDetection
  url: string
  statusCode: number
  tier: 1 | 2 | 3 | 4
  contentType: string
  totalMs: number
}

export interface ReadOptions {
  format?: "markdown" | "text"
  maxCharacters?: number
}

export interface ReadRequest extends ScrapeRequest, ReadOptions {}

export interface ReadResponse extends PageMetadata {
  text: string
  title: string
  format: "markdown" | "text"
  characters: number
  truncated: boolean
  byline?: string
  excerpt?: string
  siteName?: string
  language?: string
}

export interface ExtractionField {
  selector: string
  attribute?: string
}

export interface ExtractionOptions {
  itemSelector?: string
  fields: Record<string, ExtractionField>
  maxItems?: number
}

export interface ExtractRequest extends ScrapeRequest, ExtractionOptions {
  render?: boolean
}

export interface ExtractResponse extends PageMetadata {
  items: Record<string, string | null>[]
  matched: number
  truncated: boolean
}

export interface PoolStats {
  total: number
  busy: number
  available: number
  restarts: number
  avgRestarts: number
  // Subset of `busy` that has been checked out longer than the pool's stall threshold.
  // A stalled entry is counted in `busy` but is not real capacity - its request wedged
  // and will never call release(). `live` is the honest capacity number.
  stalled: number
  live: number
  // Current acquire() callers waiting for a free browser, and the age of the oldest
  // active checkout. Omitted by older pool implementations.
  /** Intentionally retired idle browsers which acquire() can wake. */
  sleeping?: number
  queueDepth?: number
  longestBusyMs?: number
  // True once shutdown() has begun: checkouts are refused while in-flight ones drain.
  draining?: boolean
  // Granted and timed-out acquire() calls since process start.
  acquired?: number
  exhausted?: number
  // Cumulative wait for granted checkouts only; divide by acquired for their mean wait.
  acquireWaitMsTotal?: number
}

export interface BrowserSession {
  id: string
  createdAt: number
  expiresAt: number
  busy: boolean
  keepPage: boolean
  publicOnly?: boolean
}

export interface CreateBrowserSession {
  id?: string
  proxy?: string
  headful?: boolean
  ignoreCertificateErrors?: boolean
  // Opt-in page retention: one main page stays open in the session context across
  // operations, so /scrape navigates it and session eval observes its live state.
  keepPage?: boolean
  // Isolate agent-facing sessions behind the public-destination egress policy.
  publicOnly?: boolean
}

export interface SessionEvalRequest {
  expression: string
  maxTimeout?: number
}

export interface ServerInfoResponse {
  msg: string
  version: string
  uptime: number
}

export interface RuntimeMemory {
  currentBytes: number | null
  workingSetBytes?: number
  limitBytes: number | null
  recommendedLimitBytes: number
  underProvisioned: boolean
  oomEvents: number
  oomKills: number
}

export interface HealthResponse {
  status: "ok" | "starting"
  uptime: number
  memory?: RuntimeMemory
  pool: PoolStats
}

export interface PoolSummary {
  browsers: number
  available: number
  busy: number
  stalled: number
  live: number
  restarts: number
  queueDepth?: number
  longestBusyMs?: number
  draining?: boolean
}

export interface StatsResponse extends PoolSummary {
  headful: PoolSummary | null
}

export interface SessionListResponse {
  sessions: BrowserSession[]
}

export interface SessionCookiesResponse {
  cookies: Cookie[]
}

export interface SessionEvalResponse<T = unknown> {
  value: T
}

export interface SessionCloseResponse {
  status: "ok"
}
