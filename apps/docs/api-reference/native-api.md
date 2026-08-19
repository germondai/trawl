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
| `screenshot` | boolean | false    | Capture a base64 JPEG of the viewport on the browser tiers (2–4) and return it as `screenshot`. Tier 1 is a plain HTTP fetch and never produces one                                             |
| `consoleLogs` | boolean | false   | Capture the page's console messages on the browser tiers (2–4) and return them as `consoleLogs`                                                                                                 |
| `networkLogs` | boolean | false   | Capture per-request resource timings on the browser tiers (2–4) and return them as `networkLogs`                                                                                                |
| `redirectChain` | boolean | false | Capture the URLs the main document walked on the browser tiers (2–4) and return them as `redirectChain`                                                                                         |
| `captureResponses` | string[] | — | URL patterns — a substring, or a glob matched against the whole URL when the pattern contains `*` or `?` — whose response bodies are returned as `capturedResponses` (browser tiers 2–4)     |
| `settleTimeout` | number | 15000  | Milliseconds to hold the page open after load waiting for a match; ends early on the first captured body, on `waitForSelector`, or on network idle. Only read alongside `captureResponses`  |
| `waitForSelector` | string | —    | CSS selector that also ends the settle window early. Only read alongside `captureResponses`                                                                                                 |

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
  truncated: boolean           // body trimmed to CAPTURE_MAX_RESPONSE_BYTES
  error?: string               // why the body is null (read failed, budget spent, ...)
}

interface TierResult {
  tier: 1 | 2 | 3 | 4
  status: 'success' | 'blocked' | 'needs-js' | 'timeout' | 'error' | 'skipped'
  durationMs: number
  reason?: string
}
```

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
