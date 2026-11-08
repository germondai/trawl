---
title: Session Cache
description: Automatic HTTP clearance reuse and cached browser fallback with Redis or in-memory storage.
---

# Session Cache

The shared session cache stores cookies and browser identity from successful browser requests.
It supports two reuse paths: Tier 1 can send eligible clearance over HTTP, and Tier 2 can inject
the saved cookies into a browser context. Neither path requires creating a named session.

This is a cookie cache, not a page-content cache. Each request fetches the target again. See
[Performance & Benchmarks](/getting-started/performance) for measured results and configuration.

## Automatic HTTP clearance reuse

Before an ordinary HTTP request, TRAWL checks whether the saved session can be replayed:

- The request is GET or HEAD, or a POST that sets `httpReplay: true`, and permits Tier 1. A POST
  replays only browser-verified Cloudflare or Anubis clearance, never the document proof below.
- The connection is direct: no explicit request proxy or configured datacenter proxy pool.
- TLS verification is enabled.
- The entry contains the browser's User-Agent, valid scoped cookies and provenance for the exact
  requested origin. Cloudflare `cf_clearance` and supported Anubis authentication cookies qualify
  directly; other sessions also require the document proof described below.
- The request has no imported cookies, named `sessionId`, browser capture or content-selector wait.

Cookie domain, path, expiry and secure flags are checked before sending. Same-origin redirects
can update cookies; a cross-origin redirect returns to the browser path before credentials are
forwarded. Sessions without HTTP origin provenance can still use the browser path.

The HTTP attempt receives at most five seconds or one third of the remaining request budget,
whichever is smaller. Rejected clearance, recognized challenge walls, detected JavaScript shells
and embedded widget markup fall back through the existing tiers. A successful replay refreshes
the cached cookies and browser identity without keeping another browser page open.

An opted-in POST replay keeps the request's own deadline instead of that bound, because the server
may process the submission even when the reply is slow. Only an explicit rejection of the submitted
request itself continues to the browser tiers, within the remaining request deadline: a Cloudflare
challenge announced by its `cf-mitigated` header or served as a 403/503 interstitial, an Anubis
challenge, or an AWS WAF challenge announced by its action header. Cloudflare markup must identify
an active challenge; generic titles such as "Please wait" do not authorize another submission.
A timeout, disconnect, cross-origin redirect or unresolved widget/script shell returns an error
without resending. Ordinary application replies retain their existing HTTP status/body semantics;
a generic 4xx/5xx response never authorizes a retry. POST replay does not use the generic document proof.

Browser recovery applies the same rule to both tier retries and page reloads. Before another POST,
TRAWL requires an explicit challenge rejection of the preceding submission itself. An accepted
POST whose redirect target is challenged, or a new submission with no response, cannot reuse an
older rejection as permission to retry. This does not provide exactly-once processing at the
target: after an ambiguous outcome, callers must check the target before deciding to retry.

Anubis replay recognizes the default authentication cookie names, including their optional
settings suffix. Test and referrer cookies do not qualify. Custom cookie names and clearance
bound to a browser connection retain browser fallback.

## Other direct browser sessions

Sessions without a recognized Cloudflare or Anubis clearance cookie can also use HTTP replay.
TRAWL records the exact verified URL and a hash of the normalized rendered HTML document. The HTTP response must match this document before returning it.
A partial JavaScript shell, changed document, different URL, empty body or HTML above 262,144 characters
retains browser fallback. The original Cloudflare and Anubis paths do not require this comparison.

The API can skip Tier 1 after two consecutive JavaScript-shell or content-mismatch results followed by cached browser
success for the same URL. Hints expire after 30 minutes and are bounded to 1,000 URLs. HTTP
success, fresh browser solving or failure clears the hint. Only ordinary direct GET requests
qualify; explicit `skipHttp`, HTTP-only requests, custom headers, imported cookies, named
sessions and proxy/TLS overrides retain their requested policy. These hints stay in memory
and are separate from the persistent session cache.

## Proxy-bound browser reuse

Sessions established through a configured datacenter or residential proxy retain an opaque
identity for that proxy. Tier 2 resolves it against the current proxy configuration and opens a
temporary context on the same pooled browser, with the original proxy, cookies and User-Agent.
Optional external CAPTCHA tasks use the same proxy during cached browser requests.
The context closes when the request finishes or times out. Direct sessions retain their shared
pooled-context path.

Proxy credentials are not copied into the cache. Removing the proxy, changing its credentials or
putting it in cooldown invalidates reuse of its cached session. Proxied cookies are never eligible
for direct HTTP clearance replay, and explicit per-request proxies and named sessions retain their
existing isolation rules.

The same proxy endpoint must still provide a stable exit IP for IP-bound clearance. If the site
rejects the cached session, TRAWL invalidates it and attempts a fresh solve as before.

Pool selection policies apply when entering Tier 3 or Tier 4. A Tier 2 cache hit retains the
original healthy proxy, including when fresh solves use round-robin or random selection.

## Cache driver

TRAWL supports two session cache drivers, selected at startup via `SESSION_CACHE_DRIVER`:

| Driver          | Value    | Shared across instances | External dependencies |
| --------------- | -------- | ----------------------- | --------------------- |
| Redis (default) | `redis`  | Yes                     | Redis                 |
| In-memory       | `memory` | No (per-process)        | None                  |

```ini
SESSION_CACHE_DRIVER=redis   # default, shared across instances
SESSION_CACHE_DRIVER=memory  # in-process Map, zero dependencies
```

Use `redis` when running multiple API instances behind a load balancer: sessions solved on one
instance are visible to all others. Use `memory` for single-instance deployments where the
operational overhead of Redis is not justified; sessions are scoped to the process and lost on
restart.

Both drivers support HTTP clearance reuse and browser fallback through the same `SessionCacheStore`
interface. Redis is not required for reuse in a single API process.

## Storage format

Key: `session:v2:{hostname}` (e.g. `session:v2:nowsecure.nl`)

Older Redis entries under `session:{hostname}` are ignored because their proxy origin cannot be
established safely. The first browser request after upgrading repopulates the cache; old entries
expire with their existing TTL.

Value (JSON):

```typescript
interface SessionData {
  cookies: Cookie[]
  userAgent: string
  savedAt: number     // unix timestamp ms
  proxyId?: string    // SHA-256 identity of the configured proxy, absent for direct sessions
  httpOrigin?: string // verified direct origin eligible for HTTP reuse
  httpReplay?: { url: string; contentHash: string } // optional proof for other sessions
}
```

TTL: `REDIS_SESSION_TTL_SECONDS` (default 3600 seconds / 1 hour) for both drivers. It controls cache
retention, not cookie validity; keeping an entry longer does not extend its cookies' expiry.

`httpOrigin` is recorded after an eligible direct GET/HEAD browser visit with verified TLS and the
same requested and final origin. Proxied or unverified visits do not grant HTTP replay provenance.

## Session key

The key is the **hostname only**, without a path, port or protocol. Pages on that hostname share a
cache entry, while cookie scope still controls which cookies are sent:

```
https://example.com/        → session:v2:example.com
https://example.com/page    → session:v2:example.com  (same key)
https://sub.example.com/    → session:v2:sub.example.com  (different key)
```

Subdomains have separate entries. HTTP replay additionally requires an exact match of scheme,
hostname and port with `httpOrigin`; a shared hostname key alone never authorizes replay to another origin.

## Lifecycle

```
Request permits Tier 1
  |
  +-- eligible cached clearance --> HTTP with saved cookies and User-Agent
  |                                  accepted --> refresh cache, return
  |                                  rejected --> browser fallback
  +-- otherwise -----------------> ordinary HTTP
                                     accepted --> return
                                     blocked  --> browser fallback

Browser fallback
  |
  +-- cached state --> Tier 2: inject cookies and navigate
  |                     accepted --> refresh cache, return
  |                     failed   --> invalidate entry
  +-- no usable state --> Tier 3: fresh solve; cache returned cookies
                          failed --> Tier 4 if a proxy is configured
```

Requests with imported cookies and [named browser sessions](/api-reference/browser-sessions)
retain their separate paths and do not write their login state into this shared cache. Named
sessions keep an isolated browser context and storage; they do not use HTTP clearance replay.

Tier limits, proxy routing and the remaining request budget can stop escalation earlier.

## Invalidation

If Tier 2 navigates with cached state and still receives a recognized challenge wall, the orchestrator:

1. Calls `sessionCache.invalidate(domain)` to delete the cache entry
2. Escalates to Tier 3 to get a fresh session

A rejected HTTP replay does not immediately delete the entry: the browser may still be able
to use that clearance. Invalidation follows a failed Tier 2 attempt. This handles expiry or
rejection before the cache TTL ends.

## Redis

When `SESSION_CACHE_DRIVER=redis` (the default), TRAWL uses `new RedisClient(REDIS_URL)` from Bun's native Redis client.

The cache is optional. When `REDIS_URL` is empty or unset with the Redis driver selected, TRAWL
does not create a Redis client. Shared clearance reuse and Tier 2 are unavailable; ordinary HTTP
and fresh browser solves still work.

Each connection attempt is bounded by `REDIS_CONNECT_TIMEOUT_MS` (default 5 seconds). If Redis is
not ready, scraping continues without Tier 2 while TRAWL retries in the background every
`REDIS_RETRY_DELAY_MS` (default 5 seconds). Set the retry delay to `0` to disable reconnects after a
configured Redis endpoint becomes unavailable.

```typescript
import { RedisClient } from 'bun'

const redis = new RedisClient('redis://localhost:6379')
await redis.set('session:v2:example.com', JSON.stringify(data), 'EX', 3600)
const raw = await redis.get('session:v2:example.com')
```

## In-memory

When `SESSION_CACHE_DRIVER=memory`, TRAWL uses an in-process `Map` with TTL-based expiry. There is
no network I/O, so the cache is available immediately on startup. Expired entries are removed on
read and before writes. `MEMORY_SESSION_CACHE_MAX_ENTRIES` (default 1000) bounds memory growth;
when full, the least recently used session is evicted.

Because the cache lives in the API process, sessions are **not shared** across instances. A solve
on instance A is invisible to instance B, and all sessions disappear on restart. Use this driver
only for single-instance deployments. Session contents are never written to application logs.
