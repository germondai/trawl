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

**Escalates for:** recognized Cloudflare, AWS WAF, Akamai, or Imperva challenge responses and blocked status codes such as 403 or 429. AWS WAF's `202 Challenge` and `405 CAPTCHA` responses are recognized from `x-amzn-waf-action` before the body is read. Detection also uses provider-specific HTML markers as a fallback.

**Skip with:** `skipHttp: true` in the request body, or `maxTier: 1` to cap at Tier 1.

## Tier 2 — Cached Browser Session

Reads `session:{hostname}` from Redis. If found, injects the saved cookies into a pooled Firefox context and navigates. When the target accepts the cached protection cookies and browser identity, the site loads without a fresh challenge solve.

**Succeeds for:** previously solved domains whose cached session is still accepted.

**Fails for:** expired or rejected sessions. On failure, TRAWL invalidates the cached session and escalates to Tier 3.

## Tier 3 — Fresh Challenge Solve

Acquires a browser from the pool (or waits up to `BROWSER_ACQUIRE_TIMEOUT_MS` — default 15s — for one to become available), creates a fresh Camoufox context, and navigates without preloaded cookies. TRAWL identifies the wall and runs the matching Cloudflare, AWS WAF, Akamai, or Imperva wait flow until the protected page replaces the interstitial or `maxTimeout` elapses.

On success:
- Extracts all cookies from the page context
- Writes `session:{hostname} → { cookies, userAgent, savedAt }` to Redis (TTL = `SESSION_TTL_SECONDS`)
- Returns the HTML and cookies to the caller

Uses [Camoufox](https://github.com/daijro/camoufox) — Firefox with fingerprint patching at the C++/Juggler level to reduce common automation signals. Success still depends on the target's challenge variant, IP reputation, and upstream network conditions.

### AWS WAF challenges and CAPTCHA

Tier 1 and the forward proxy recognize AWS WAF `Challenge` and `CAPTCHA` rule actions. Tier 3 and Tier 4 let the official AWS challenge script mint the `aws-waf-token` in the same browser context. For an interactive CAPTCHA, TRAWL opens the accessibility audio challenge, transcribes it, submits the answer, and waits for the widget and interstitial to clear. Embedded widgets created with `AwsWafCaptcha.renderCaptcha` use the same solver after the page loads.

The built-in Google speech endpoint is available without configuration. A Whisper-compatible `STT_URL` is recommended for AWS WAF audio because challenge audio and speech-recognition behavior vary between deployments. Image-grid-only variants are not currently solved.

### Akamai Bot Manager challenges

Tier 3 and Tier 4 detect Akamai's `sec-cpt` / SBSD behavioral interstitials. The Akamai flow generates human-like pointer movement, handles supported press-and-hold widgets, waits for a valid `_abck` sensor cookie, and revisits the original URL when the interstitial does not reload automatically.

Akamai configurations vary between properties and change over time. TRAWL treats a persistent interstitial as blocked and can escalate to Tier 4 when a residential proxy is configured.

### Imperva/Incapsula challenges

Tier 3 and Tier 4 also detect and resolve supported Imperva/Incapsula WAF challenges. Imperva's `reese84` (current) / `___utmvc` (legacy) sensor cookies are produced by an obfuscated in-page JS challenge. TRAWL detects the response with `packages/tiers/src/utils/detect.ts` and waits for the sensor cookie through `packages/tiers/src/utils/impervaWait.ts`.

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
| 3    | Challenge-dependent | Yes (fresh solve)    |
| 4    | 15–45s       | Yes (fresh solve + proxy) |
