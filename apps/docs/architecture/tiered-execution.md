---
title: Tiered Execution
description: How TRAWL escalates through four tiers — from a plain fetch to a residential proxy solve.
---

# Tiered Execution

Every scrape request runs through a four-tier waterfall. Each tier is only tried if the previous one fails or is skipped. This means you pay the cheapest cost that works for each request — most requests never need a browser.

```
Request
  │
  ▼
Tier 1: Plain HTTP Fetch ─── success ──→ return (< 100ms)
  │ blocked / needs-js
  ▼
Tier 2: Cached Session ────── success ──→ return (~500ms)
  │ blocked / cache miss
  ▼
Tier 3: Fresh Challenge ───── success ──→ cache cookies, return
  │ IP flagged
  ▼
Tier 4: Residential Proxy ─── success ──→ cache cookies, return (15–45s)
  │ failed
  ▼
  error
```

## Tier 1 — Plain HTTP Fetch

The cheapest tier. Uses Bun's native `fetch()` with a realistic browser header set:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131...
Accept: text/html,application/xhtml+xml,...
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate, br
```

**Succeeds for:** sites that serve the requested content without a browser challenge.

**Escalates for:** recognized Cloudflare, Akamai, Imperva or Anubis challenge responses and blocked status codes such as 403 or 429. Detection uses provider-specific headers and HTML markers.

**Skip with:** `skipHttp: true` in the request body, or deployment-wide `SCRAPE_MIN_TIER=2`.
Use `maxTier: 1` to cap execution at Tier 1 instead.

## Tier 2 — Cached Browser Session

Reads `session:{hostname}` from Redis. If found, injects the saved cookies into a pooled Firefox context and navigates. When the target accepts the cached protection cookies and browser identity, the site loads without a fresh challenge solve.

**Succeeds for:** previously solved domains whose cached session is still accepted.

**Fails for:** expired or rejected sessions. On failure, TRAWL invalidates the cached session and escalates to Tier 3.

## Tier 3 — Fresh Challenge Solve

Acquires a browser from the pool (or waits up to `BROWSER_ACQUIRE_TIMEOUT_MS` — default 15s — for one to become available), creates a fresh Camoufox context, and navigates without preloaded cookies. TRAWL identifies the wall and runs the matching Cloudflare, Akamai, or Imperva wait flow until the protected page replaces the interstitial or `maxTimeout` elapses.

On success:
- Extracts all cookies from the page context
- Writes `session:{hostname} → { cookies, userAgent, savedAt }` to Redis (TTL = `REDIS_SESSION_TTL_SECONDS`)
- Returns the HTML and cookies to the caller

Uses [Camoufox](https://github.com/daijro/camoufox) — Firefox with fingerprint patching at the C++/Juggler level to reduce common automation signals. Success still depends on the target's challenge variant, IP reputation, and upstream network conditions.

### Anubis proof-of-work challenges

Anubis can return both challenges and denial pages with HTTP 200. TRAWL recognizes its active challenge JSON, its version metadata together with the real bootstrap script, and its version metadata together with the rejection image. Broken challenge JSON stays a challenge when the bootstrap is present. Inert examples, brand mentions and version metadata alone do not trigger detection. HTTP and proxy inspection also check for Anubis markers beyond the normal 64 KiB preview in an already buffered response.

The browser executes the site's own challenge JavaScript. TRAWL waits for two readable destination samples at the same URL within the remaining tier budget. Short destination pages are accepted; empty shells, browser errors, failed verification endpoints and repeated challenge reissues are rejected. TRAWL does not compute a separate PoW solution or navigate to a challenge endpoint itself.

Tier 2 reuses accepted sessions. If Anubis challenges or rejects the cached session, TRAWL invalidates it and proceeds to a fresh Tier 3 context when the requested maximum tier allows it. Tiers 3 and 4 retain their existing context isolation, proxy routing and TLS settings. Failures report reasons such as `anubis-session-expired`, `anubis-blocked`, `anubis-challenge-timeout` or `anubis-persistent`. A closed browser page reports `anubis-browser-closed`. For GET and HEAD, TRAWL retries once in a fresh context on the same proxy within the original request budget, provided the browser is still connected. POST is not retried. Anubis verification redirects are left to the browser even when `followMetaRefresh` is enabled, so the generic refresh fallback does not resubmit the verification endpoint. The forward proxy returns 403 for unresolved Anubis evidence originally served below HTTP 400, or 504 for a timeout. Existing upstream error statuses are preserved.

Real-browser integration tests cover Anubis v1.27.0 with the `fast` algorithm at difficulty 2, including the native API, FlareSolverr `/v1` and HTTP proxy. Higher difficulty, custom frontends, hard deny policies, browser failures and other deployments can still fail. No new configuration flag or paid solver is required.


### Akamai Bot Manager challenges

Tier 3 and Tier 4 detect Akamai's `sec-cpt` / SBSD behavioral interstitials. The Akamai flow generates human-like pointer movement, handles supported press-and-hold widgets, waits for a valid `_abck` sensor cookie, and revisits the original URL when the interstitial does not reload automatically.

Akamai configurations vary between properties and change over time. TRAWL treats a persistent interstitial as blocked and can escalate to Tier 4 when a residential proxy is configured.

### Imperva/Incapsula challenges

Tier 3 and Tier 4 also detect and resolve supported Imperva/Incapsula WAF challenges. Imperva's `reese84` (current) / `___utmvc` (legacy) sensor cookies are produced by an obfuscated in-page JS challenge. TRAWL detects the response with `packages/tiers/src/utils/detect.ts` and waits for the sensor cookie through `packages/tiers/src/utils/impervaWait.ts`.

Detection checks active challenge frames and sensor bootstrap shells. Cookie names in article text, inactive HTML examples, and ordinary Imperva CDN headers alone do not trigger browser escalation.

**Caveat:** unlike Turnstile, Imperva's script sometimes layers in TLS/JA3 and behavioral checks beyond plain cookie generation, and its obfuscation changes periodically — success isn't guaranteed at the same rate as Cloudflare. Some Imperva deployments also show a visible interactive CAPTCHA widget (distinct from hCaptcha/reCAPTCHA) instead of the passive sensor-only path; that variant isn't solved yet.

### DataDome challenges

Tier 3 and Tier 4 detect the three DataDome responses. All of them arrive through
`captcha-delivery.com`:

| Response | Marker | TRAWL action |
| --- | --- | --- |
| Device Check | `i.js` script, `dd.rt = 'i'` | Runs `packages/tiers/src/utils/datadomeWait.ts` and waits for a new `datadome` cookie |
| Slider CAPTCHA | `c.js` script, `dd.rt = 'c'` | Reports `datadome-captcha-required`. No solver yet |
| Hard block | `t=bv` on the challenge URL | Reports the IP as blocked and escalates to Tier 4 |

The block-only `x-dd-b` response header lets the MITM proxy escalate before the body arrives.

Some DataDome Device Check deployments require a browser running behind a display. TRAWL
sends detected DataDome work to an opt-in headful pool running behind Xvfb.

Tier 1 can select the pool before browser acquisition. If a later tier detects DataDome,
the orchestrator replaces the headless lease and retries that tier once. The optional pool
is warmed during startup.

The sub-pool is off by default: set `BROWSER_HEADFUL_POOL_SIZE=1` to scrape DataDome
targets. See [Configuration](/getting-started/configuration).

## Tier 4 — Residential Proxy Escalation

Same as Tier 3 but launches the browser with `RESIDENTIAL_PROXY_URL` set as the proxy. Only triggered when:

1. `RESIDENTIAL_PROXY_URL` is configured
2. Tier 3 failed (usually because the datacenter IP is flagged)

If `RESIDENTIAL_PROXY_URL` is not set, Tier 4 is skipped entirely and the request returns an error after Tier 3 fails.

## Tier selection

The orchestrator (`packages/tiers/src/orchestrator.ts`) controls escalation. You can limit it via `ScrapeRequest.maxTier`:

```json
{ "url": "...", "maxTier": 2 }
```

This runs Tier 1, then Tier 2, then returns an error if both fail — never launching a fresh browser solve.

## Timing reference

| Tier | Typical time | Browser used              |
| ---- | ------------ | ------------------------- |
| 1    | 50–150ms     | No                        |
| 2    | 400–700ms    | Yes (warm)                |
| 3    | Challenge-dependent | Yes (fresh solve)    |
| 4    | 15–45s       | Yes (fresh solve + proxy) |
