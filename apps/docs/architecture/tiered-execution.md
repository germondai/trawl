---
title: Tiered Execution
description: How TRAWL escalates through four tiers - from a plain fetch to a residential proxy solve.
---

# Tiered Execution

Ordinary scrape requests use a four-tier waterfall, subject to request limits and proxy policy.
Each tier is tried only when earlier work fails or is skipped. Named browser sessions use their
own retained context and bypass the shared clearance cache.

```
Request
  │
  ▼
Tier 1: HTTP Fetch ───────── success ──→ return
  │ optional cached clearance + saved browser identity
  │ bounded Anubis/NCBI/ALTCHA/Friendly v1 access-wall solving
  │ blocked / needs-js
  ▼
Tier 2: Cached Session ────── success ──→ refresh cache, return
  │ blocked / cache miss
  ▼
Tier 3: Fresh Challenge ───── success ──→ cache cookies, return
  │ IP flagged
  ▼
Tier 4: Residential Proxy ─── success ──→ cache cookies, return
  │ failed
  ▼
  error
```

<span id="tier-1-&#8212;-plain-http-fetch"></span>

## Tier 1 - Plain HTTP Fetch

The cheapest tier. Uses Bun's native `fetch()` by default, with Firefox navigation
headers. Set [`TIER1_TRANSPORT=wreq`](/getting-started/configuration#tier1-transport)
to opt into Firefox TLS/HTTP2 impersonation. Its native profile supplies the fresh
HTTP User-Agent; accepted clearance replays keep the saved browser identity.
The default Bun header set is:

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

**Succeeds for:** sites that serve the requested content without a browser challenge, supported NCBI or Anubis proof-of-work walls, and supported ALTCHA or Friendly Captcha v1 access forms.

For GET requests, Tier 1 can solve NCBI identity PoW and Anubis `fast`, `slow`,
`sha256`, `argon2id`, `hashx`, `preact` and `metarefresh` without opening a browser.
Standard and baseline images bundle the Rust solver. Local source runs can use a
JavaScript fallback for text SHA-256; the other hash algorithms require the library
at `/opt/powsolve/libpowsolve.so` (or an operator-supplied `POWSOLVE_LIB` path).

Supported static ALTCHA and Friendly Captcha v1 access forms use the same transport,
cookie jar and bounded PoW process. Friendly v1 uses native Blake2b-256 when available;
its JavaScript fallback and ALTCHA derivations run in that child process too. Ordinary
embedded widgets, callbacks and ambiguous forms stay on the browser path; see
[challenge support](/getting-started/challenge-support) for the form and resource limits.

Hashing runs in one short-lived process with one native search thread, for at most
one second within the request deadline. Cancellation kills that process; busy,
unsupported, rejected or timed-out solves retain browser escalation. Server-required
waits also stay within the request deadline. The submit endpoint must share the wall's
origin, cookies retain their scope, and caller POST/PUT requests are never resubmitted
by this fast path. Returned clearance cookies are available to native and `/v1` callers
and through `Set-Cookie` for proxy clients. They do not create browser-verified shared
cache provenance. Responses with partitioned cookies or previously unverified parent-domain
cookies retain browser fallback rather than widening the HTTP jar's cookie scope.

Eligible repeat requests send saved Cloudflare or Anubis clearance cookies and the browser's
User-Agent rather than making an unauthenticated probe. The response is fetched again, not
served from a body cache. Rejected clearance falls back to the browser tiers. This requires
a direct GET/HEAD request (or a POST with `httpReplay: true`, which replays clearance cookies only, keeps
the request's own deadline and is never resent after a timeout or disconnect), verified TLS and matching origin provenance; see
[Session Cache](/architecture/session-cache#automatic-http-clearance-reuse) for eligibility and fallback.

**Escalates for:** recognized Cloudflare, Akamai, or Imperva challenge responses and blocked status codes such as 403 or 429. Detection uses provider-specific headers and HTML markers.

Fresh GET/HEAD attempts with an eligible browser fallback wait at most 10 seconds for response
headers, within the overall request deadline. After headers arrive, ordinary response bodies keep
the full remaining deadline. HTTP-only requests and other methods retain their original budgets;
cached clearance replays keep their existing shorter budget. A Cloudflare `cf-mitigated: challenge`
header triggers escalation immediately, without waiting for the challenge body to finish.

**Skip with:** `skipHttp: true` in the request body, or deployment-wide `SCRAPE_MIN_TIER=2`.
Use `maxTier: 1` to cap execution at Tier 1 instead.

<span id="tier-2-&#8212;-cached-browser-session"></span>

## Tier 2 - Cached Browser Session

Reads `session:v2:{hostname}` from the configured Redis or memory cache. If found, injects the saved
cookies into a pooled Firefox context and navigates. Proxy-bound sessions use an isolated temporary
context on the same browser through their original configured proxy. This path also handles clearance that the
HTTP tier cannot reuse. When the target accepts the cached cookies and browser identity, the
site loads without a fresh challenge solve.

**Succeeds for:** previously solved domains whose cached session is still accepted.

**Fails for:** expired or rejected sessions. On failure, TRAWL invalidates the cached session and escalates to Tier 3.

<span id="tier-3-&#8212;-fresh-challenge-solve"></span>

## Tier 3 - Fresh Challenge Solve

Acquires a browser from the pool (or waits up to `BROWSER_ACQUIRE_TIMEOUT_MS`, default 15s,
within the remaining request budget), creates a fresh Camoufox context and navigates. Ordinary
solves start without cached cookies; explicitly imported cookies use an isolated context and
do not enter the shared cache. TRAWL identifies the wall and runs the matching provider flow
until the protected page replaces it or the request deadline expires.

On success:

- Extracts cookies from the page context.
- Saves eligible shared session state when cookies are available, using the configured cache
  driver and `REDIS_SESSION_TTL_SECONDS`. Direct, TLS-verified GET/HEAD visits with matching
  requested and final origins can record `httpOrigin` for later HTTP reuse.
- Returns the HTML and cookies to the caller.

Uses [Camoufox](https://github.com/daijro/camoufox) - Firefox with fingerprint patching at the C++/Juggler level to reduce common automation signals. Success still depends on the target's challenge variant, IP reputation, and upstream network conditions.

### Cloudflare recovery and fallback

A `cf_clearance` cookie alone does not confirm page access. The Cloudflare waiter still
requires two readable observations without an active challenge. If clearance is present but
the redirect has not completed after five seconds, TRAWL attempts one recovery navigation.
An unchanged clearance and a wall that persists for another five seconds stop that attempt.
A newly issued clearance token receives a fresh grace period without repeating the navigation.

When Tier 4 is allowed and a configured residential proxy is outside cooldown, ordinary
requests reserve one third of the remaining time, capped at 30 seconds, for escalation.
This cutoff applies only to Tier 3 Cloudflare waiting and is shared across datacenter retries.
Other provider flows and page readiness retain the request budget. Requests with an explicit
proxy, or without an available residential fallback, do not reserve this time.

### Embedded CAPTCHA widgets

Detected access challenges must clear before content is returned. After the page loads,
`solveEmbeddedCaptchas` controls attempts on embedded form widgets: native `/scrape` and MCP
`scrape` default to `true`; FlareSolverr-compatible `/v1` defaults to `false`. Set it to `false`
when only page content is needed, or `true` to request widget attempts. These are best-effort
attempts within the request deadline, reserving two seconds for document capture.

Only verified widget solutions appear in `captchasSolved`. An iframe can remain mounted after
completion, so iframe disappearance is not used as proof of success. See the
[native API](/api-reference/native-api#embedded-captcha-widgets) for request semantics.

| Provider         | Attempted path                                                                    | Confirmation                                              |
| ---------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Turnstile        | Existing shadow-DOM or frame checkbox interaction                                 | Widget response token                                     |
| reCAPTCHA v2     | Checkbox or audio challenge                                                       | Existing response/checked-state checks                    |
| hCaptcha         | Checkbox auto-pass; audio where the site offers it                                | Checked checkbox state; image grids remain unsupported    |
| GeeTest slide    | Piece texture matching with screenshot fallback; up to three recalculated puzzles | Explicit verified widget state, never just a closed popup |
| ALTCHA           | Native component verification or checkbox                                         | Verified state/response                                   |
| Friendly Captcha | Native component or provider-frame start                                          | Completed response                                        |
| CAP              | Native component or its shadow control                                            | Component response token                                  |

CAP uses the installed widget's own PoW implementation, browser proxy and outbound policy. It adds no solver dependency or external paid service. Component readiness and offscreen controls are handled within the request budget. Visible CAP widgets are solved sequentially within the shared budget, and all must have a response before completion is reported. The solver does not submit the surrounding form.

A widget's client-side response is not proof that the target application's server accepted a subsequent business request. Targets with unsupported puzzles or IP restrictions can still refuse access.

### Akamai Bot Manager challenges

Tier 3 and Tier 4 detect Akamai's `sec-cpt` / SBSD behavioral interstitials. The Akamai flow handles supported press-and-hold widgets, stops the gesture when the main document navigates, waits for a valid `_abck` sensor cookie, and revisits the original URL when the interstitial does not reload automatically. Sensor-only pages receive bounded pointer movement. Recovery stays within the remaining request budget.

Akamai configurations vary between properties and change over time. TRAWL treats a persistent interstitial as blocked and can escalate to Tier 4 when a residential proxy is configured.

### Imperva/Incapsula challenges

Tier 3 and Tier 4 also detect and resolve supported Imperva/Incapsula WAF challenges. Imperva's `reese84` (current) / `___utmvc` (legacy) sensor cookies are produced by an obfuscated in-page JS challenge. TRAWL detects the response with `packages/tiers/src/utils/detect.ts` and waits for the sensor cookie through `packages/tiers/src/utils/impervaWait.ts`.

Detection checks active challenge frames and sensor bootstrap shells. Cookie names in article text, inactive HTML examples, and ordinary Imperva CDN headers alone do not trigger browser escalation.

**Caveat:** unlike Turnstile, Imperva's script sometimes layers in TLS/JA3 and behavioral checks beyond plain cookie generation, and its obfuscation changes periodically - success isn't guaranteed at the same rate as Cloudflare. Some Imperva deployments also show a visible interactive CAPTCHA widget (distinct from hCaptcha/reCAPTCHA) instead of the passive sensor-only path; that variant isn't solved yet.

### DataDome challenges

Tier 3 and Tier 4 detect the three DataDome responses. All of them arrive through
`captcha-delivery.com`:

| Response       | Marker                       | TRAWL action                                                                          |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| Device Check   | `i.js` script, `dd.rt = 'i'` | Runs `packages/tiers/src/utils/datadomeWait.ts` and waits for a new `datadome` cookie |
| Slider CAPTCHA | `c.js` script, `dd.rt = 'c'` | Reports `datadome-captcha-required`. No solver yet                                    |
| Hard block     | `t=bv` on the challenge URL  | Reports the IP as blocked and escalates to Tier 4                                     |

The block-only `x-dd-b` response header lets the MITM proxy escalate before the body arrives.

Some DataDome Device Check deployments require a browser running behind a display. TRAWL
sends detected DataDome work to an opt-in headful pool running behind Xvfb.

Tier 1 can select the pool before browser acquisition. If a later tier detects DataDome,
the orchestrator replaces the headless lease and retries that tier once. The optional pool
is warmed during startup.

The sub-pool is off by default: set `BROWSER_HEADFUL_POOL_SIZE=1` to scrape DataDome
targets. See [Configuration](/getting-started/configuration).

<span id="tier-4-&#8212;-residential-proxy-escalation"></span>

## Tier 4 - Residential Proxy Escalation

Same as Tier 3 but launches the browser with `RESIDENTIAL_PROXY_URL` set as the proxy. Only triggered when:

1. `RESIDENTIAL_PROXY_URL` is configured
2. Tier 3 failed (usually because the datacenter IP is flagged)

If `RESIDENTIAL_PROXY_URL` is not set, Tier 4 is skipped entirely and the request returns an error after Tier 3 fails.

## Tier selection

The orchestrator (`packages/tiers/src/orchestrator.ts`) controls escalation. You can limit it via `ScrapeRequest.maxTier`:

```json
{ "url": "...", "maxTier": 2 }
```

This runs Tier 1, then Tier 2, then returns an error if both fail - never launching a fresh browser solve.

## Reading tier timings

| Tier | Work performed                                        | Browser used   |
| ---- | ----------------------------------------------------- | -------------- |
| 1    | HTTP fetch, optionally with eligible cached clearance | No             |
| 2    | Navigate with cached cookies and browser identity     | Yes, warm pool |
| 3    | Fresh context and challenge solving                   | Yes, warm pool |
| 4    | Browser solve through the configured proxy            | Yes, warm pool |

Latency depends on the target, network, clearance acceptance and challenge variant. A fast
Tier 1 repeat is not a measurement of first-visit challenge solving. See
[Performance & Benchmarks](/getting-started/performance) for recorded first/repeat results
and CPU/memory measurements instead of fixed per-tier timing estimates.

### Anubis proof of work

Anubis uses the site's own JavaScript for proof of work. TRAWL polls a small browser DOM summary every 300 ms, respects the remaining request budget, and rejects denial pages or unresolved verification endpoints. Supported cached authentication cookies can enable direct HTTP reuse; rejected clearance returns to the browser tiers. PoW CPU and memory usage depend on the target policy and browser worker count; a 1 GiB limit is not sufficient for every public deployment.

A closed Anubis browser page may be retried once for GET or HEAD within the original timeout. If the container cgroup reports a new OOM kill, TRAWL stops instead of repeating the expensive solve. On systems without cgroup counters, recovery remains limited to one retry. POST requests are never replayed.

## Optional paid fallback

A deployment can enable the [external CAPTCHA solver](/getting-started/configuration#optional-external-captcha-solver).
It runs after supported built-in solvers inside browser tiers 2-4, using the same
page and the remaining request deadline. It is not a fifth tier. One shared
allowance limits paid task creation across all tiers and proxy attempts.
Automatic fallback handles declarative reCAPTCHA v2/Enterprise, standalone
Turnstile and supported Turnstile-based Cloudflare Challenge Pages. For the latter,
an opt-in observer installed before navigation captures document-bound render
parameters and the original callback. Local solving runs first; the provider
answer must match the browser identity and the wall must clear before success.
Other documented API v2 task types use hostname-bound profiles with
explicit inputs, delivery and a verification selector. A detected SDK marker
alone never creates a paid task. Profile-enabled hostnames escalate HTTP HTML
responses to a browser, and WAF waiters can use a profile after local resolution
fails. Existing local handling is preserved when the service is disabled.
