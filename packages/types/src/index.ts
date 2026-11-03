import type { Cookie, InputCookie, ScrapeResponse } from "./api"

export type * from "./api"

export interface ScrapeResult extends Omit<ScrapeResponse, "body"> {
  body?: Uint8Array
}

export interface SessionData {
  cookies: Cookie[]
  userAgent: string
  savedAt: number
  // Opaque identity of the configured proxy that established this session.
  proxyId?: string
  // Origin verified by a direct browser request. Absent on legacy/proxied sessions.
  httpOrigin?: string
  // Same-URL document proof for HTTP replay without a recognized clearance cookie.
  httpReplay?: { url: string; contentHash: string }
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

// Per-instance HTTP-level fingerprint (User-Agent + matching navigator.platform /
// locale / timezone) - @trawl/browser's FINGERPRINT_POOL is typed against this shape.
export interface BrowserFingerprint {
  userAgent: string
  platform: "Win32" | "MacIntel" | "Linux x86_64" | "Linux armv8"
  locale: string
  timezone: string
}

// A leased browser+context pair handed to a tier by @trawl/browser's BrowserPool.
// `context`/`browser` are `any` - camoufox-js doesn't export Playwright's
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
  retainBrowser?: () => () => void
  noteTemporaryContext?: () => void
  requestBrowserReplacement?: (reason: string) => void
}

// Per-request proxy override as it arrives at the API. Prowlarr's Cardigann flow
// serializes this as an object (its FlareSolverrProxy class: {url, username, password}).
// Other callers may send a plain URL string. The API boundary normalizes both forms
// into a single URL string before handing off to the orchestrator.
export type ProxyEndpointInput = string | { url?: string; server?: string; username?: string; password?: string }

export interface FlareSolverrScrapeRequest {
  cmd?: "request.get" | "request.post"
  session?: string
  session_ttl_minutes?: number
  cookies?: InputCookie[]
  returnOnlyCookies?: boolean
  returnScreenshot?: boolean
  // TRAWL extension: defaults to false; access challenges are always resolved.
  solveEmbeddedCaptchas?: boolean
  url: string
  maxTimeout?: number
  postData?: string
  headers?: Record<string, string>
  // TRAWL extension (not part of the FlareSolverr v2 contract) - per-request proxy override.
  // Accepts Prowlarr's {url, username, password} object shape OR a plain URL string.
  proxy?: ProxyEndpointInput
}

export interface FlareSolverrSessionRequest {
  cmd: "sessions.create" | "sessions.list" | "sessions.destroy"
  session?: string
  proxy?: ProxyEndpointInput
}

export type FlareSolverrRequest = FlareSolverrScrapeRequest | FlareSolverrSessionRequest

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
    response?: string
    screenshot?: string
    cookies: Cookie[]
    userAgent: string
  }
}
