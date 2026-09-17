---
title: Native API
description: POST /scrape — the native TRAWL endpoint with full tier control.
---

# `POST /scrape` — Native API

The native endpoint exposes TRAWL's full feature set: tier capping, session IDs, and rich timing metadata.

## Request

```typescript
interface ScrapeRequest {
  url: string
  maxTimeout?: number                    // ms, default 60000
  skipHttp?: boolean                     // skip Tier 1 (plain fetch), default false
  maxTier?: 1 | 2 | 3 | 4              // cap escalation at this tier
  sessionId?: string                     // sticky session override key
  headers?: Record<string, string>       // custom headers forwarded to the target
  proxy?: string                         // per-request proxy override for Tier 3/4
  screenshot?: boolean                   // capture a viewport screenshot, default false
  consoleLogs?: boolean                  // capture browser console messages, default false
  networkLogs?: boolean                  // capture per-request resource timings, default false
  redirectChain?: boolean                // capture the main document's redirect chain, default false
  captureResponses?: string[]            // URL patterns whose response bodies to capture, default none
  settleTimeout?: number                 // ms to wait after load for a match, default 15000
  waitForSelector?: string               // CSS selector that ends the settle window early
  blockedEvidence?: boolean              // return the challenge wall on the error, default false
  mhtml?: boolean                        // assemble an MHTML archive of the page, default false
  ignoreCertificateErrors?: boolean      // load the page even if its TLS certificate fails verification, default false
}
```

### Fields

| Field        | Type    | Default  | Description                                                                                                                                                                                    |
| ------------ | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`        | string  | —        | The URL to scrape                                                                                                                                                                              |
| `maxTimeout` | number  | 60000    | Max total time in milliseconds                                                                                                                                                                 |
| `skipHttp`   | boolean | false    | Skip Tier 1 (go straight to browser)                                                                                                                                                           |
| `maxTier`    | 1–4     | 4        | Never escalate beyond this tier                                                                                                                                                                |
| `sessionId`  | string  | hostname | Override the Redis session key                                                                                                                                                                 |
| `headers`    | object  | —        | Custom headers forwarded to the target across all tiers — see [Custom Headers](/api-reference/custom-headers)                                                                                  |
| `proxy`      | string  | —        | Strict proxy route for this request. HTTP(S) proxies are used by Tier 1 and browser tiers; SOCKS proxies skip Tier 1. Direct Tier 1 and the unproxied Tier 2 cache are never used — see [Configuration § Proxies](/getting-started/configuration#proxies) |
| `screenshot` | boolean | false    | Capture a base64 JPEG of the viewport on browser tiers (2–4) and return it as `screenshot`. Tier 1 never produces one; use `skipHttp: true` to force a browser attempt                        |
| `consoleLogs` | boolean | false   | Capture the page's console messages on the browser tiers (2–4) and return them as `consoleLogs`                                                                                                 |
| `networkLogs` | boolean | false   | Capture per-request resource timings on the browser tiers (2–4) and return them as `networkLogs`                                                                                                |
| `redirectChain` | boolean | false | Capture the URLs the main document walked on the browser tiers (2–4) and return them as `redirectChain`                                                                                         |
| `captureResponses` | string[] | — | URL patterns — a substring, or a glob matched against the whole URL when the pattern contains `*` or `?` — whose response bodies are returned as `capturedResponses` (browser tiers 2–4)     |
| `settleTimeout` | number | 15000  | Milliseconds to hold the page open after load waiting for a match; ends early on the first captured body, on `waitForSelector`, or on network idle. Only read alongside `captureResponses`  |
| `waitForSelector` | string | —    | CSS selector that also ends the settle window early. Only read alongside `captureResponses`                                                                                                 |
| `blockedEvidence` | boolean | false | When no tier clears the challenge, attach the wall the last browser tier stopped at to the 500 body as `blockedEvidence`. It is never attached to a successful result — see the note below. The image rides along only when `screenshot` is also set |
| `mhtml` | boolean | false        | Assemble a `multipart/related` MHTML archive of the page on the browser tiers (2–4) and return it as `mhtml`. An approximation of "Save as MHTML", not an engine snapshot — see the note below |
| `ignoreCertificateErrors` | boolean | false | Load the page even when its TLS certificate fails verification (expired, self-signed, issued for another host) instead of failing the fetch. Off by default, so every other caller keeps a verified connection. An unverified connection no longer proves whose page came back, so the request also gets the crossed-landing guard — see the note below |

Captured response bodies, headers, console messages, URLs, blocked-page HTML, screenshots,
and MHTML archives can contain credentials, tokens, personal data, or active scripts.
Treat these opt-in fields as sensitive and open archives only when you trust their source.

## Response

```typescript
interface ScrapeResult {
  url: string                  // final URL after redirects
  html: string
  cookies: Cookie[]
  userAgent: string
  statusCode: number
  tier: 1 | 2 | 3 | 4        // which tier succeeded
  sessionCached: boolean       // true if a cached session was used
  timings: TierResult[]        // per-tier attempt history
  totalMs: number
  captchasSolved?: string[]    // captcha types solved on the page itself (e.g. ['turnstile'])
  proxyUsed?: boolean          // true if the winning tier routed through a proxy (Tier 3 datacenter pool or Tier 4 residential pool/override)
  screenshot?: string          // base64 JPEG of the viewport, only when requested and a browser tier served the page
  consoleLogs?: ConsoleLogEntry[]  // console messages, only when requested and a browser tier served the page
  networkLogs?: NetworkLogEntry[]  // resource timings, same presence rules as consoleLogs
  redirectChain?: string[]     // URLs the main document walked, same presence rules as consoleLogs
  capturedResponses?: CapturedResponseEntry[]  // matched response bodies, [] when nothing matched
  mhtml?: string               // bounded multipart/related archive, only for requested successful HTML browser results
  certificateError?: string    // why the certificate failed verification, only when ignoreCertificateErrors was set and a verified attempt observed it
}

interface ConsoleLogEntry {
  level: 'SEVERE' | 'WARNING' | 'INFO' | 'DEBUG'
  message: string
  timestamp: number            // epoch milliseconds
  source: string               // console type that produced the message (e.g. 'error')
}

interface NetworkLogEntry {
  name: string                 // request URL
  entryType: 'navigation' | 'resource'
  startTime: number            // ms since the capture attached
  duration: number             // ms from request start to last byte, 0 if it never completed
  initiatorType: string        // resource type (document, script, xhr, image, ...)
  transferSize: number | null  // response body + headers on the wire
  encodedBodySize: number | null
  decodedBodySize: number | null  // always null — knowing it would mean reading every body
}

interface CapturedResponseEntry {
  url: string
  status: number
  headers: Record<string, string>
  body: string | null          // text, or base64 when binary/unknown; null when unreadable
  base64Encoded: boolean
  truncated: boolean           // body trimmed to CAPTURE_MAX_BODY_BYTES
  error?: string               // why the body is null (read failed, budget spent, ...)
}

interface TierResult {
  tier: 1 | 2 | 3 | 4
  status: 'success' | 'blocked' | 'needs-js' | 'timeout' | 'error' | 'skipped'
  durationMs: number
  reason?: string
}
```

## Blocked-Outcome Evidence

A scrape that runs a browser but never clears the challenge is still a failure: it answers
**500**, and `ScrapeResult` never carries a challenge wall dressed up as content.

`blockedEvidence: true` attaches the wall to that failure instead, so a caller can tell
"blocked by a challenge" from "TRAWL broke" and can keep the page as evidence:

```typescript
interface BlockedEvidence {
  tier: 2 | 3 | 4              // which browser tier rendered the wall
  status: 'blocked' | 'timeout'
  reason?: string              // identical to the matching timings[].reason
  url: string                  // where the browser stood, after any challenge redirects
  statusCode?: number
  html: string                 // the wall's markup
  htmlTruncated?: boolean      // html is the head of a page over BLOCKED_EVIDENCE_MAX_HTML_CHARS
  screenshot?: string          // base64 JPEG, only when `screenshot` was also requested
}
```

The wall reported is the **last attempt from the deepest** browser tier that rendered one —
a Tier 3 wall is replaced by Tier 4's when Tier 4 also fails, and a later proxy attempt
replaces an earlier one in the same tier. Some failures have no page to hand
back at all and carry no evidence: Tier 1 (a plain HTTP fetch, no browser), a tier that
could not open a context or a page, a hard network failure (DNS, connection refused, TLS),
an `about:neterror` page, an empty document, and a pool that was exhausted or still
initializing. In those cases `timings` alone tells the story.

Capturing the wall never changes the outcome: markup is truncated to its configured cap,
the optional screenshot respects the remaining request budget, and a capture failure
degrades or omits `blockedEvidence`. The status code and `timings` are unchanged either way.

## MHTML Archives

`mhtml: true` returns a single bounded `multipart/related` document for a successful HTML
page: the rendered DOM first, then safely readable stylesheets, scripts, images and fonts
that were observed loading. It is pure 7-bit
ASCII with CRLF line endings, so it can be written straight to a `.mhtml` file, and every
part carries a `Content-Location` so a reader can resolve it back to its URL.

It is an **assembled approximation, not an engine snapshot.** Firefox exposes no
equivalent of Chromium's `Page.captureSnapshot`, so the archive is built from what the
response listener saw. Resources served from cache, fetched before the listener attached,
compressed, missing a valid `Content-Length`, or refused by the browser are absent. These
omissions and anything dropped for a size budget are counted in the
`X-Trawl-Omitted-Resources` header and, up to the configured record cap, listed in a final
`text/plain` part, so an archive that hits a cap is still a valid MHTML that says what it
is missing. Non-HTML responses and roots too large for the total cap leave `mhtml` unset.
The field is excluded from `timings` and tier telemetry. Bounds are tunable via `MHTML_*` — see
[Configuration](/getting-started/configuration#mhtml-archives).

MHTML may contain credentials, personal data and executable JavaScript from the target.
Treat it as sensitive untrusted content; do not log it or open it outside an appropriate
sandbox unless you trust the page.

## Invalid Certificates

`ignoreCertificateErrors: true` lets a page load even though its certificate is expired,
self-signed or issued for another host — without it the fetch fails outright and nothing
about the page is readable. The relaxation is per request: Tier 1 retries the fetch
unverified only after a verified attempt failed on the certificate, Tiers 3 and 4 set it on
the temporary context they create for that one request, and the pooled contexts every other
caller uses stay verified. Tier 2 is skipped for these requests (it replays its session
inside the shared pool context, whose TLS policy cannot be changed per request) and shows up
in `timings` as `skipped`.

When the verified attempt is what failed, its reason comes back as `certificateError`, e.g.
`"DEPTH_ZERO_SELF_SIGNED_CERT: self signed certificate"`. The field is absent when the
certificate verified, when the flag was not set, and when no verified attempt was made
(`skipHttp: true`) — absence means "not observed", not "the certificate was valid".

### The crossed-landing guard

A verified certificate is what normally proves the bytes came from the host that was asked
for. With verification off, a connection that reaches the wrong origin would be accepted in
silence and another site's page returned under the requested domain's name. So an opted-in
request also runs a landing check: if the scrape ends on a host the requested URL is not part
of, TRAWL fetches the same URL over the same egress with a plain HTTP client. Only when that
probe stays on the requested host is the landing treated as crossed; the tier's attempt is
recorded as `crossed-landing on <host>` and the ladder moves to the next tier, which reaches
the origin over a different egress. A probe that fails, or that lands off-host as well (an
ordinary redirect, or cloaking), is inconclusive and the page is kept. The same off-host
landing reached from two independent egresses is taken as a redirect only a browser performs
and accepted. The probe runs inside what is left of the request's `maxTimeout`, with a 2s
floor so a spent budget cannot turn the check into a no-op, and it validates every redirect
hop against the same outbound policy the tiers enforce. If no tier returns an uncrossed page
the request fails, and the error names the refused landing rather than returning another
site's page.

An unverified page is untrusted content by definition. The guard establishes only that the
connection reached the host that was asked for; it says nothing about whether that host is
who it claims to be, which is exactly what the unverified certificate failed to establish.

## Examples

### Minimal request

```bash
curl -s -X POST http://localhost:8191/scrape \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://nowsecure.nl" }' | jq '{tier, totalMs, sessionCached}'
```

### Force browser only (skip plain HTTP)

```bash
curl -s -X POST http://localhost:8191/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://nowsecure.nl",
    "skipHttp": true,
    "maxTier": 3
  }'
```

### Inspect timing breakdown

```javascript
const res = await fetch('http://localhost:8191/scrape', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://nowsecure.nl' }),
})

const result = await res.json()

console.log(`Tier used: ${result.tier}`)
console.log(`Session cached: ${result.sessionCached}`)
console.log(`Total: ${result.totalMs}ms`)

for (const t of result.timings) {
  console.log(`  Tier ${t.tier}: ${t.status} in ${t.durationMs}ms`)
}
```

### Example response

```json
{
  "url": "https://nowsecure.nl",
  "html": "<!DOCTYPE html>...",
  "cookies": [
    { "name": "cf_clearance", "value": "abc123...", "domain": ".nowsecure.nl", "path": "/", "expires": 1700003600, "httpOnly": false, "secure": true }
  ],
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
  "statusCode": 200,
  "tier": 2,
  "sessionCached": true,
  "timings": [
    { "tier": 1, "status": "needs-js", "durationMs": 85 },
    { "tier": 2, "status": "success", "durationMs": 512 }
  ],
  "totalMs": 600
}
```

## Error response

HTTP status codes:

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 200  | `tier` succeeded                                                     |
| 400  | Malformed request body                                               |
| 429  | Pool exhausted — all browsers busy past `BROWSER_ACQUIRE_TIMEOUT_MS` |
| 503  | Browser pool initializing                                            |
| 500  | Internal error                                                       |

For 429 pool-exhaustion errors, the body is a **FlareSolverr v2 envelope** (same shape `/v1` uses) so clients can parse both endpoints uniformly:

```json
{
  "status": "error",
  "message": "Browser pool saturated, retry shortly",
  "startTimestamp": 1700000000000,
  "endTimestamp": 1700000015000,
  "version": "2.0.0",
  "solution": {
    "url": "https://nowsecure.nl",
    "status": 0,
    "headers": {},
    "response": "",
    "cookies": [],
    "userAgent": ""
  }
}
```

For 400 / 503 the body is the native shape `{ "error": "Human-readable message" }`.

For 500 errors raised after at least one tier was attempted, the body also includes the
per-tier attempt history, so a failed request is still fully diagnosable from the response
alone — no need to check server logs:

```json
{
  "error": "All tiers exhausted. Last failure: http-403",
  "timings": [
    { "tier": 1, "status": "needs-js", "durationMs": 50, "reason": "cloudflare-challenge" },
    { "tier": 3, "status": "blocked", "durationMs": 2942, "reason": "http-403" },
    { "tier": 4, "status": "blocked", "durationMs": 7890, "reason": "http-403" }
  ]
}
```

When the request set `blockedEvidence: true` and a browser tier rendered a challenge wall,
the same body also carries that page — see
[Blocked-Outcome Evidence](#blocked-outcome-evidence):

```json
{
  "error": "All tiers exhausted. Last failure: cloudflare-persistent",
  "timings": [
    { "tier": 1, "status": "needs-js", "durationMs": 50, "reason": "cloudflare-challenge" },
    { "tier": 3, "status": "blocked", "durationMs": 2942, "reason": "cloudflare-persistent" },
    { "tier": 4, "status": "blocked", "durationMs": 7890, "reason": "cloudflare-persistent" }
  ],
  "blockedEvidence": {
    "tier": 4,
    "status": "blocked",
    "reason": "cloudflare-persistent",
    "url": "https://nowsecure.nl/",
    "statusCode": 403,
    "html": "<!DOCTYPE html><html><head><title>Just a moment...</title>...",
    "screenshot": "/9j/4AAQSkZJRgABAQAA..."
  }
}
```
