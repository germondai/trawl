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

The cheapest tier. Uses Bun's native `fetch()` with the same Firefox navigation header set the Camoufox browser tiers send:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate, br, zstd
Upgrade-Insecure-Requests: 1
Sec-Fetch-Dest: document
Sec-Fetch-Mode: navigate
Sec-Fetch-Site: none
Sec-Fetch-User: ?1
Priority: u=0, i
```

**Succeeds for:** sites that serve the requested content without a browser challenge.

**Escalates for:** recognized Cloudflare, Akamai, or Imperva challenge responses and blocked status codes such as 403 or 429. Detection uses provider-specific headers and HTML markers.

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

### Embedded CAPTCHA widgets

Embedded widgets proceed to their own solver after the page loads. Their iframe can remain mounted after completion, so iframe disappearance is not used as proof of success.

| Provider | Attempted path | Confirmation |
| --- | --- | --- |
| Turnstile | Existing shadow-DOM or frame checkbox interaction | Widget response token |
| reCAPTCHA v2 | Checkbox or audio challenge | Existing response/checked-state checks |
| hCaptcha | Checkbox auto-pass; audio where the site offers it | Checked checkbox state; image grids remain unsupported |
| GeeTest slide | Piece texture matching with screenshot fallback; up to three recalculated puzzles | Explicit verified widget state, never just a closed popup |
| ALTCHA | Native component verification or checkbox | Verified state/response |
| Friendly Captcha | Native component or provider-frame start | Completed response |
| CAP | Native component or its shadow control | Component response token |

CAP uses the installed widget's own PoW implementation, browser proxy and outbound policy. It adds no solver dependency or external paid service. Component readiness and offscreen controls are handled within the request budget. The solver does not submit the surrounding form.

A widget's client-side response is not proof that the target application's server accepted a subsequent business request. Targets with unsupported puzzles or IP restrictions can still refuse access.

### Akamai Bot Manager challenges

Tier 3 and Tier 4 detect Akamai's `sec-cpt` / SBSD behavioral interstitials. The Akamai flow handles supported press-and-hold widgets, stops the gesture when the main document navigates, waits for a valid `_abck` sensor cookie, and revisits the original URL when the interstitial does not reload automatically. Sensor-only pages receive bounded pointer movement. Recovery stays within the remaining request budget.

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

Anubis uses the site's own JavaScript for proof of work. TRAWL polls a small browser DOM summary every 300 ms, respects the remaining request budget, and rejects denial pages or unresolved verification endpoints. Expired cached sessions escalate to a fresh browser context. PoW CPU and memory usage depend on the target policy and browser worker count; a 1 GiB limit is not sufficient for every public deployment.

A closed Anubis browser page may be retried once for GET or HEAD within the original timeout. If the container cgroup reports a new OOM kill, TRAWL stops instead of repeating the expensive solve. On systems without cgroup counters, recovery remains limited to one retry. POST requests are never replayed.
