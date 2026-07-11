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
Tier 3: Fresh Challenge ───── success ──→ cache cookies, return (4–15s)
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

**Succeeds for:** sites without Cloudflare, sites that serve HTML to plain HTTP.

**Fails for:** sites behind Cloudflare JS challenge (returns `Checking your browser...` interstitial or HTTP 403/429). The detector checks for the `cf-mitigated` response header and the challenge page title/body.

**Skip with:** `skipHttp: true` in the request body, or `maxTier: 1` to cap at Tier 1.

## Tier 2 — Cached Browser Session

Reads `session:{hostname}` from Redis. If found, injects the saved cookies into a pooled Firefox context and navigates. Because the Cloudflare `cf_clearance` cookie is present, the challenge page is skipped and the site loads directly.

**Succeeds for:** any domain that was previously solved by Tier 3 and whose session hasn't expired.

**Fails for:** expired sessions (Cloudflare `cf_clearance` has a finite lifetime). On failure, TRAWL invalidates the cached session and escalates to Tier 3.

## Tier 3 — Fresh Cloudflare Challenge Solve

Acquires a browser from the pool (or waits up to `BROWSER_ACQUIRE_TIMEOUT_MS` — default 15s — for one to become available). Navigates to the URL with no pre-loaded cookies. Waits for the Cloudflare challenge to resolve by polling `page.content()` every 500ms until the interstitial HTML is gone or `maxTimeout` elapses.

On success:
- Extracts all cookies from the page context
- Writes `session:{hostname} → { cookies, userAgent, savedAt }` to Redis (TTL = `SESSION_TTL_SECONDS`)
- Returns the HTML and cookies to the caller

Uses [Camoufox](https://github.com/daijro/camoufox) — Firefox with fingerprint patching at the C++/Juggler level. CF's detection scripts cannot distinguish it from a real Firefox profile.

### Imperva/Incapsula challenges

Tier 3 and Tier 4 also detect and solve Imperva/Incapsula WAF challenges, not just Cloudflare. Imperva's `reese84` (current) / `___utmvc` (legacy) sensor cookies are produced by an obfuscated in-page JS challenge — same principle as Cloudflare's `cf_clearance`: a real browser executing real JS produces the cookie without needing to understand the obfuscation. TRAWL detects the challenge page (`packages/tiers/src/detect.ts`'s `hasImpervaChallenge`) and polls for the sensor cookie (`packages/tiers/src/impervaWait.ts`) instead of the Cloudflare-specific wait loop.

**Caveat:** unlike Turnstile, Imperva's script sometimes layers in TLS/JA3 and behavioral checks beyond plain cookie generation, and its obfuscation changes periodically — success isn't guaranteed at the same rate as Cloudflare. Some Imperva deployments also show a visible interactive CAPTCHA widget (distinct from hCaptcha/reCAPTCHA) instead of the passive sensor-only path; that variant isn't solved yet.

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
| 3    | 4–15s        | Yes (fresh solve)         |
| 4    | 15–45s       | Yes (fresh solve + proxy) |
