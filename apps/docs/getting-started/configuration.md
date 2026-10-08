---
title: Configuration
description: All environment variables for TRAWL, with defaults and examples.
---

# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit before starting.

## MCP

### `MCP_ENABLED`

**Default:** `false`

Enables the Streamable HTTP endpoint at `POST/GET /mcp`. It exposes read-only tools
for readable content, HTML, screenshots and browser diagnostics. It does not add web
search, ranking or result discovery. Keep the endpoint on a trusted private network;
the endpoint does not provide authentication.

```ini
MCP_ENABLED=true
```

### `MCP_ALLOWED_ORIGINS`

**Default:** _(empty)_

Comma-separated browser origins permitted to access `/mcp`. Server-to-server requests
without an `Origin` header are accepted. When a browser sends `Origin`, it must exactly
match an entry in this list.

```ini
MCP_ALLOWED_ORIGINS=https://chat.example.com,https://admin.example.com
```

## Session Cache Driver

### `SESSION_CACHE_DRIVER`

**Default:** `redis`

Selects the backend used for the Tier 2 session cache. Redis remains the default to preserve
cross-instance session sharing and backward compatibility.

```ini
SESSION_CACHE_DRIVER=redis   # default — shared across instances, requires Redis
SESSION_CACHE_DRIVER=memory  # in-process Map, zero external dependencies
```

Use `memory` for single-instance deployments where running Redis is not justified. Sessions are
scoped to the API process and lost on restart — they are **not shared** across instances. See
[Session Cache](/architecture/session-cache) for details.

Unknown values stop startup with a configuration error instead of silently selecting another
backend.

### `MEMORY_SESSION_CACHE_MAX_ENTRIES`

**Default:** `1000`

Maximum number of sessions retained by the memory driver. Once full, it evicts the least recently
used session. Expired sessions are removed automatically on reads and writes.

## Redis

### `REDIS_URL`

**Default:** _(empty — Redis driver disabled)_

Standard Redis connection URL — the bundled Compose service uses Redis 8. Set a non-empty URL to enable
the session cache. When running inside Docker Compose use the service name:

```ini
REDIS_URL=redis://redis:6379
```

With authentication:

```ini
REDIS_URL=redis://:yourpassword@redis:6379
```

With a specific database index:

```ini
REDIS_URL=redis://redis:6379/1
```

### `REDIS_CONNECT_TIMEOUT_MS`

**Default:** `5000`

Maximum duration of each Redis connection attempt. A failed attempt does not block the API or
permanently disable Tier 2; TRAWL continues without the cache and reconnects in the background.

### `REDIS_RETRY_DELAY_MS`

**Default:** `5000`

Delay between background connection attempts. Set it to `0` when Redis is intentionally absent to
disable retries. The supplied minimal Compose variant does this automatically.

### `REDIS_SESSION_TTL_SECONDS`

**Default:** `3600` (1 hour)

How long solved browser cookies and user-agent state are cached per domain by either driver. After
this TTL the next protected request triggers a fresh challenge solve and refreshes the cache.

Cloudflare's `cf_clearance` cookie typically has a 30-minute expiry. Setting
`REDIS_SESSION_TTL_SECONDS` below 1800 wastes cache hits; setting it above 7200 risks replaying
expired cookies. TRAWL handles an expired cookie by invalidating the cache and falling back to Tier 3.

```ini
REDIS_SESSION_TTL_SECONDS=3600   # default — safe for most sites
REDIS_SESSION_TTL_SECONDS=1800   # more conservative
```

## Scrape Tier Floor

### `SCRAPE_MIN_TIER`

**Default:** `1`

Sets the lowest tier that `/scrape`, FlareSolverr `/v1`, MCP tools, and MITM scraper fallbacks may
use. Tier `1` preserves the normal plain HTTP fast path, `2` starts with a cached browser session,
`3` starts with a fresh browser solve, and `4` goes directly to a residential or explicitly supplied
proxy. Tier 2 is skipped naturally when no cached session exists.

```ini
SCRAPE_MIN_TIER=1   # normal adaptive ladder
SCRAPE_MIN_TIER=2   # never make the plain HTTP request
SCRAPE_MIN_TIER=3   # never reuse a cached browser session
SCRAPE_MIN_TIER=4   # require residential or per-request proxy routing
```

Use a floor above `1` when an early request itself affects the target's fingerprint or when every
request must reach a particular proxy-backed tier. Higher floors increase latency and browser-pool
load. An invalid value stops TRAWL at startup, and a request whose `maxTier` is below the configured
floor fails before any outbound request. The native API's `skipHttp: true` can raise the effective
floor to Tier 2 but cannot lower this deployment-wide setting.

For the MITM forward proxy, this setting applies only after the request enters the scraper ladder.
Set `MITM_ALWAYS_SCRAPE=true` as well when the proxy's direct Tier 0 probe must also be disabled.

## User Prefs

### `USER_PREFS`

**Default:** _(unset)_

A JSON object of Firefox prefs applied to every launched browser, merged after TRAWL's built-in
launch prefs. Values must be strings, booleans or signed 32-bit integers; arrays, objects,
`null` and fractional numbers are rejected at startup. Prefs apply at browser launch,
so restart TRAWL after changing them.

For a deployment that already routes `.onion` traffic through Tor and supplies DNS:

```ini
USER_PREFS={"network.dns.blockDotOnion":false}
```

`network.proxy.failover_direct=false` and `network.proxy.socks_remote_dns=true` remain
enforced even if supplied in `USER_PREFS`. Other preferences can override built-in
values, including process counts, so configure them with your resource limits in mind.

## Browser Pool

### `METRICS_DASHBOARD_ENABLED` and `METRICS_DASHBOARD_TOKEN`

**Default:** _(unset)_

For a port bound to `127.0.0.1`, set `METRICS_DASHBOARD_ENABLED=true` to open
the local dashboard without a token. If the port can be reached by others,
set a random token of at least 32 characters. The token is sent as a Bearer
header and held only in the browser tab's memory; it takes precedence over
the tokenless setting. See the
[metrics guide](../api-reference/health-stats.md#local-metrics-dashboard).

```ini
METRICS_DASHBOARD_ENABLED=true
# Or use a token for authenticated access:
# METRICS_DASHBOARD_TOKEN=<random-secret-at-least-32-characters>
METRICS_DB_PATH=/data/metrics/trawl.sqlite
```

### `LOG_LEVEL`

**Default:** `info`

Controls correlated operational logging. `info` records every scrape start, tier outcome, and final success or failure with a correlation ID. In these correlated entries, URLs omit credentials, query strings, and fragments, and request bodies, headers, cookies, and proxy credentials are not logged. Use `warn`, `error`, or `silent` to reduce these entries; `debug` also admits future verbose operational events. Solver progress writes separate diagnostic lines that can include CAPTCHA answers, token previews, transcription output, frame URLs, and audio URLs. Treat logs as sensitive and configure access control and Docker log rotation accordingly.

```ini
LOG_LEVEL=info
```

### `BROWSER_POOL_SIZE`

**Default:** `1`

Number of Camoufox Firefox instances to keep warm. Each instance uses ~350–500 MB RAM under load. Start conservative and raise if you need higher concurrency.

```ini
BROWSER_POOL_SIZE=1   # default — recommended for Prowlarr and ordinary scraping
BROWSER_POOL_SIZE=3   # concurrent browser solves; allow at least 2 GB RAM
BROWSER_POOL_SIZE=8   # high-throughput (6+ GB host RAM)
```

> **Note:** Pool size controls concurrency, not solver capability. The API container sets `shm_size: 1gb` by default. Shared memory does not replace the container memory limit.

### `BROWSER_ACQUIRE_TIMEOUT_MS`

**Default:** `15000` (15 seconds)

Maximum queue wait for a free browser before rejecting with `PoolExhaustedError`. Queue time also consumes the request's remaining `maxTimeout`: the shorter deadline wins. Waiting requests wake when capacity becomes available, without periodic queue polling. The default pool intentionally favors low memory use; raise the pool when sustained concurrent browser solves are expected.

Lower it for fail-fast client feedback (Prowlarr will see 429s sooner and retry on its own). Raise it for very heavy upstream targets or when you've bumped `BROWSER_POOL_SIZE` higher.

```ini
BROWSER_ACQUIRE_TIMEOUT_MS=5000    # fail fast — 429s after 5s
BROWSER_ACQUIRE_TIMEOUT_MS=15000   # default — bounded queue before HTTP 429
BROWSER_ACQUIRE_TIMEOUT_MS=30000   # tolerate longer queueing on slow targets
```

When the timeout fires, both `/v1` and `/scrape` return **HTTP 429** with the FlareSolverr v2 error envelope (not a 500).

### `BROWSER_RECYCLE_AFTER_CONTEXTS`

**Default:** `8`

How many Tier 3 or Tier 4 temporary contexts a pooled browser can create before TRAWL replaces the browser process. Every context counts, regardless of outcome. With at least 512 MiB of container memory headroom, TRAWL warms one replacement while the existing browser remains available. In containers limited to 1 GiB or less, or with less headroom, it closes the old browser first; queued requests may wait for the new browser to start.

The API reads Linux cgroup v1/v2 memory usage, subtracting reclaimable inactive file cache for recycling decisions. After a browser-backed request finishes, working-set usage above 85% of the container limit also requests recycling. Outside supported cgroups, only context-count recycling applies. This reduces sustained memory growth and replacement peaks; it cannot prevent a single memory-heavy page or CAPTCHA from exhausting the container.

```ini
BROWSER_RECYCLE_AFTER_CONTEXTS=8   # default - replace after 8 Tier 3/4 contexts
BROWSER_RECYCLE_AFTER_CONTEXTS=0   # disable count-based recycling; memory-pressure recovery remains
```

### `BROWSER_IDLE_TIMEOUT_MS`

Default: `0` (disabled).

Retire an unused browser after this many milliseconds. The next browser-backed request launches it again; ordinary HTTP scraping stays available. Session cookies stored in the configured cache survive idle retirement. The first browser request after retirement pays a cold start, and Firefox's in-memory cache is lost. Active requests, cleanup and queued acquires prevent retirement. The health endpoint counts intentionally sleeping capacity separately from live browsers.

```dotenv
BROWSER_IDLE_TIMEOUT_MS=300000 # optional: retire after five minutes idle
```

### `BROWSER_BLOCK_ADS`

**Default:** `true`

Load Camoufox's bundled uBlock Origin extension. Set `false` to omit it and reduce extension memory and CPU overhead. Both headless and optional headful pools use this setting. Ads, trackers and other resources normally blocked by uBlock can then load; resource use may increase on ad-heavy pages. Scripts, images, proxy routing and TLS verification otherwise retain their existing behavior.

For a small single-browser container, start with:

```ini
BROWSER_POOL_SIZE=1
BROWSER_MAX_CONTENT_PROCESSES=2
BROWSER_HARDWARE_CONCURRENCY=4
BROWSER_BLOCK_ADS=false
```

This is a resource tuning option, not a guarantee that every browser workload fits in 1 GiB. Use a larger limit for heavy pages, difficult CAPTCHAs or the additional headful pool.

### `BROWSER_HARDWARE_CONCURRENCY`

Optional browser-reported logical CPU count, from 1 to 64. Unset preserves Camoufox's generated fingerprint. This changes the native browser configuration, rather than injecting JavaScript into target pages.

PoW implementations such as Anubis size their worker pool from this value. For a small container, try `BROWSER_HARDWARE_CONCURRENCY=4` with `BROWSER_POOL_SIZE=1`. Fewer workers can reduce CPU and RAM usage, but may take longer to solve difficult challenges. This is not a hard CPU or memory limit; configure those in Docker.

### `BROWSER_MAX_CONTENT_PROCESSES`

**Default:** `2`

Caps Firefox content processes per pooled browser via the `dom.ipc.processCount` Firefox pref. Firefox's default of 8 lets thread count climb when Tier 3 / Tier 4 churn disposable contexts (see #13). The cap bounds the leak at the source without paying the recycle cost. Raise if specific targets fail with empty content (rare).

```ini
BROWSER_MAX_CONTENT_PROCESSES=2   # default content-process preference
BROWSER_MAX_CONTENT_PROCESSES=4   # raise if CF/Imperva challenges stall
```

### `BROWSER_HEADFUL_POOL_SIZE`

**Default:** `0` (disabled)

Browsers in the headful sub-pool. This pool runs behind an Xvfb virtual display and serves
DataDome Device Check escalations that require a browser running behind a display.

Set it to `1` to scrape DataDome targets. It is off by default because the sub-pool is
**additional to `BROWSER_POOL_SIZE`**: one headful browser plus its X display measures about
380 MB (a headful browser is roughly twice a headless one, and Xvfb adds ~65 MB), so leaving
it on would move the memory ceiling of deployments that never meet DataDome. Account for it
in `mem_limit` before enabling.

When enabled, the sub-pool is warmed during API startup. A launch failure therefore fails
startup instead of delaying an individual scrape.
Readiness at `/health` reports the main pool only; the sub-pool appears under `headful` at
`/stats`, and reads `null` while disabled.

With the sub-pool disabled, a DataDome escalation fails immediately with a configuration error.

The container images ship the `xvfb` binary.

```ini
BROWSER_HEADFUL_POOL_SIZE=0   # default - no headful browser
BROWSER_HEADFUL_POOL_SIZE=1   # required for DataDome targets, ~380 MB on first use
```

### Browser recovery timeouts

| Variable | Default | Purpose |
| --- | ---: | --- |
| `BROWSER_STALL_TIMEOUT_MS` | `180000` | Grace period after a request's own timeout before its browser checkout is reclaimed |
| `BROWSER_CLOSE_TIMEOUT_MS` | `10000` | Maximum wait for a wedged browser or context to close |
| `BROWSER_LAUNCH_TIMEOUT_MS` | `90000` | Maximum wait for Camoufox to launch |

These bounds keep an unresponsive Firefox process from permanently consuming a pool slot. The defaults are suitable for most installations.

## Screenshots

Only read when a request sets `screenshot: true` — see [Native API](/api-reference/native-api).

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SCREENSHOT_SETTLE_MS` | `3000` | Maximum wait for the network to go idle before capturing |
| `SCREENSHOT_TIMEOUT_MS` | `10000` | Maximum wait for the capture itself |
| `SCREENSHOT_JPEG_QUALITY` | `60` | JPEG quality, 1–100 |
| `SCREENSHOT_MAX_BYTES` | `4000000` | Images larger than this are dropped rather than returned |

A screenshot is never worth failing a scrape: exceeding any of these bounds leaves
`screenshot` unset and logs the reason, and the scrape result is otherwise unchanged.
Tier 1 is a plain HTTP fetch and never captures a screenshot. Set `skipHttp: true` if
you need to force a browser-tier attempt.

## Console and Network Diagnostics

Only read when a request sets `consoleLogs` or `networkLogs` — see
[Native API](/api-reference/native-api). Without those flags no listener is attached and
nothing is buffered.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DIAGNOSTICS_MAX_CONSOLE_ENTRIES` | `500` | Console messages kept per page |
| `DIAGNOSTICS_MAX_NETWORK_ENTRIES` | `1000` | Requests kept per page |
| `DIAGNOSTICS_MAX_STRING_CHARS` | `2000` | Longest single console message or request URL kept |
| `DIAGNOSTICS_MAX_TOTAL_CHARS` | `1000000` | Total characters kept across both arrays |
| `DIAGNOSTICS_SIZE_TIMEOUT_MS` | `2000` | Maximum wait for the browser's per-request byte counts |

Anything past a cap is dropped whole rather than truncated, and the number of dropped
entries is logged once per scrape. A capture failure leaves the field unset and never
fails the scrape.

Console messages and request URLs may contain credentials, tokens, personal data, or
other sensitive values. Treat diagnostic fields as sensitive output and avoid storing
or forwarding them unless necessary.

## Redirect Capture

Only read when a request sets `redirectChain`. The tracker records only top-level document URLs;
subresource redirects are excluded.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `REDIRECT_MAX_ENTRIES` | `50` | URLs kept in the redirect chain |
| `REDIRECT_MAX_URL_CHARS` | `2000` | Longest individual redirect URL kept |
| `REDIRECT_MAX_TOTAL_CHARS` | `1000000` | Total characters kept across the redirect chain |

## Response-Body Capture

Only read when a request sets `captureResponses` — see
[Native API](/api-reference/native-api). Without patterns no listener is attached and no
body is read.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CAPTURE_MAX_PATTERNS` | `10` | URL patterns honoured per request |
| `CAPTURE_MAX_RESPONSES` | `5` | Bodies kept per page, in arrival order |
| `CAPTURE_MAX_BODY_BYTES` | `5242880` | Bytes kept per body; past it the body is trimmed and flagged `truncated` |
| `CAPTURE_MAX_TOTAL_BYTES` | `10485760` | Bytes kept across all bodies of one page |
| `CAPTURE_MAX_READ_BYTES` | `10485760` | Largest body this process will read at all; a larger one is reported with an `error` instead of a trimmed prefix |
| `CAPTURE_MAX_METADATA_CHARS` | `2000` | Longest captured URL, header name, header value, or error kept |
| `CAPTURE_BODY_TIMEOUT_MS` | `5000` | Maximum wait for in-flight body reads when the capture is drained |
| `CAPTURE_SETTLE_MS` | `15000` | Default settle window when a request does not set `settleTimeout` |
| `CAPTURE_MAX_SETTLE_MS` | `60000` | Ceiling a request may ask for; the request's own time budget also caps it |
| `CAPTURE_IDLE_FLOOR_MS` | `5000` | Network idle is ignored for this long, so a data fetch on a delayed timer is not mistaken for a quiet page |

A response that matched but whose body could not be read is still returned, with `body`
null and `error` set, so "nothing matched" stays distinguishable from "matched, retrieval
failed".

A body read cannot be cut short once it has started — the browser API returns whole bodies
only — so the budgets above bound what is read, not just what is kept. Only identity-encoded
bodies with a valid `Content-Length` are read. Compressed or unknown-size bodies are
returned with `body: null` and an error. Declared sizes are reserved cumulatively before
reads start, so concurrent responses cannot exceed the total read budget.

## Blocked-Outcome Evidence

Only retained when a request sets `blockedEvidence: true` — see
[Native API](/api-reference/native-api#blocked-outcome-evidence). Without it the failure
path captures no additional image or response data. Only the last wall is kept per request,
and its markup, screenshot size and screenshot time are all bounded.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `BLOCKED_EVIDENCE_MAX_HTML_CHARS` | `512000` | Characters of the wall kept; past it `html` is the head of the page and `htmlTruncated` is set |

The wall is truncated rather than dropped: unlike a stylesheet or an image, the head of a
challenge page still carries the title, vendor markers and incident id a caller classifies
on. Capturing it never fails the scrape, and screenshots cannot extend the request budget.
Challenge markup and screenshots can contain tokens, credentials or personal data; avoid
logging, persisting or publicly exposing them unless that is explicitly intended.

## Favicons

Only read when a request sets `favicons: true` — see
[Native API](/api-reference/native-api#favicons). Without it no icon is resolved and no
request is made.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `FAVICON_MAX_ENTRIES` | `8` | Icons fetched per page, apex first then declared in document order |
| `FAVICON_MAX_BYTES` | `524288` | Largest single icon kept. Declared oversize bodies are refused; unknown-size bodies are streamed and cancelled when they cross the cap |
| `FAVICON_MAX_METADATA_CHARS` | `8192` | Maximum characters kept for an icon URL, content type, or error message |
| `FAVICON_FETCH_TIMEOUT_MS` | `5000` | Maximum wait for one icon |
| `FAVICON_TIMEOUT_MS` | `20000` | Ceiling on the whole collection; the request's own remaining `maxTimeout` also caps it, and collection is skipped once that budget is spent |

An icon that could not be read is returned with `error` set rather than dropped, and a
collection failure leaves `favicons` empty and never fails the scrape.
Tier 1 has no page context and therefore never produces icons; use `skipHttp: true` when the
response must contain the requested favicon collection.

## MHTML Archives

Only read when a request sets `mhtml: true` — see
[Native API](/api-reference/native-api#mhtml-archives). Without it no subresource body is
read. The archive keeps many small parts rather than a few large bodies, so it carries
budgets of its own rather than sharing the response-body ones.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MHTML_MAX_PARTS` | `200` | Subresources archived per page |
| `MHTML_MAX_PART_BYTES` | `2097152` | Bytes per subresource; a larger one is omitted whole |
| `MHTML_MAX_TOTAL_CHARS` | `8388608` | Maximum characters in the complete serialized archive, including the rendered root and MIME overhead |
| `MHTML_MAX_INFLIGHT_READS` | `32` | Subresource bodies read at the same time; a burst past this is omitted rather than held |
| `MHTML_MAX_OMISSION_RECORDS` | `100` | Omissions listed by URL in the archive; the rest are only counted |

Bodies are read as they arrive, so a page whose subresources all complete at once is
bounded by `MHTML_MAX_INFLIGHT_READS` and by the archive budget reserved from each valid
`Content-Length`. Because the browser API returns only complete bodies, compressed and
unknown-size responses are omitted before reading rather than trusted after allocation.
When `captureResponses` selects the same resource, both outputs share one browser body read.

A subresource is omitted rather than trimmed — a truncated stylesheet or image is corrupt,
not partial. Every omission is counted in the archive's `X-Trawl-Omitted-Resources` header;
up to `MHTML_MAX_OMISSION_RECORDS` are listed in its final part. Non-HTML responses, a root
that cannot fit the total cap, or an assembly failure leave `mhtml` unset and never fail
the scrape. Archives may contain credentials, personal data and executable target scripts,
so treat them as sensitive untrusted output.

## Optional external CAPTCHA solver

Built-in solvers remain the default. Set `CAPTCHA_SOLVER=2captcha` and
`TWOCAPTCHA_API_KEY` to try a paid fallback after local solving fails. A key by
itself never enables the service. No additional model or solver SDK is installed.

| Variable | Default | Description |
| --- | --- | --- |
| `CAPTCHA_SOLVER` | `none` | `none` or `2captcha` |
| `TWOCAPTCHA_API_KEY` | unset | Required when selecting 2Captcha; keep it secret |
| `CAPTCHA_SOLVER_MAX_TASKS` | `1` | Maximum paid task creation attempts per scrape, shared across tiers and proxy retries; range 1-3 |
| `CAPTCHA_SOLVER_LOCAL_TIMEOUT_MS` | `10000` | Budget offered to a supported built-in solver before fallback; range 1000-30000 ms |
| `CAPTCHA_SOLVER_TIMEOUT_MS` | `120000` | External operation limit, also capped by the remaining scrape budget; range 1000-180000 ms |
| `CAPTCHA_SOLVER_PROFILES` | unset | JSON array of hostname-specific task and delivery profiles; up to 64 profiles, 256 KB total |

```dotenv
CAPTCHA_SOLVER=2captcha
TWOCAPTCHA_API_KEY=your-key
```

### Automatic widget fallback

The default adapter handles **one declarative reCAPTCHA v2, v2 Enterprise or
standalone Turnstile widget per provider on a page**, with `data-sitekey` and an
optional named `data-callback`. It installs the response in the current page and
invokes the callback in the page's JavaScript realm. It does not submit forms
itself. Turnstile custom response fields, callback-only widgets and reCAPTCHA
compatibility mode are supported. reCAPTCHA uses the browser user agent and the
widget's Google or recaptcha.net API domain. Enterprise `data-s` is sent inside
`enterprisePayload`.

A restrictive script CSP or missing named callback prevents task creation.
Anonymous callbacks, explicitly rendered widgets, multiple widgets, reCAPTCHA v3
and Cloudflare interstitials require a site-specific profile. Existing local
solvers, including hCaptcha, remain available. A token delivered to a field is
reported as `delivered`, not as proof of target-server acceptance.

### Provider task catalogue

TRAWL validates the API v2 task shapes documented by
[2Captcha](https://2captcha.com/api-docs). The catalogue covers reCAPTCHA
v2/Enterprise/v3, Turnstile, Arkose/FunCaptcha, GeeTest, Capy, KeyCaptcha, Lemin,
AWS WAF, CyberSiara, MTCaptcha, DataDome, Friendly Captcha, CutCaptcha, ATB,
Tencent, Prosopo, CaptchaFox, VK, ALTCHA, Yidun, Binance, Hunt, TSPD, Basilisk,
Imperva, Alibaba and Yandex, plus image/text/audio, rotation, coordinates, grids,
drawing, bounding boxes, drag-and-drop, Temu, SmartCaptcha and Pazl tasks.

Recognizable SDK and widget markers produce diagnostic candidates. A marker
alone never starts a paid task. Apart from the automatic widgets above, these
tasks need a profile providing the required dynamic parameters and a way to
apply and verify the response. Generic images or audio are not automatically
classified as CAPTCHA. Detection cannot cover every customized website or SDK
variant. hCaptcha is not included in the current API v2 catalogue used here; no
undocumented external task type is sent.

The catalogue accepts the alternative names and field spellings present in the
provider's examples, including Imperva/Incapsula and Alibaba. Those documentation
inconsistencies have not been resolved against a live paid account. Structural
validation is not a guarantee that the provider will accept a task.

### Site-specific profiles

Profiles are server configuration, not request parameters. Each profile binds an
exact lowercase hostname, a unique widget root, a documented `taskType`, task
inputs and an explicit delivery method. The selector must identify one widget;
missing or ambiguous targets prevent payment. No wildcard hostnames are allowed.

For example, save this array as the JSON value of `CAPTCHA_SOLVER_PROFILES`:

```json
[
  {
    "hostname": "example.com",
    "selector": "#captcha",
    "taskType": "GeeTestTaskProxyless",
    "inputs": {
      "gt": { "selector": "#captcha", "attribute": "data-gt" },
      "challenge": { "source": "global", "path": ["captchaConfig", "challenge"] }
    },
    "delivery": {
      "fields": [
        { "selector": "#geetest-challenge", "path": ["challenge"] },
        { "selector": "#geetest-validate", "path": ["validate"] },
        { "selector": "#geetest-seccode", "path": ["seccode"] }
      ],
      "callback": "captchaAccepted",
      "verifySelector": "#protected-content"
    }
  }
]
```

Use selectors and callback names belonging to your target integration. The
example is a schema illustration, not a universal GeeTest configuration.
Configured hostnames force otherwise successful HTTP HTML responses through a
browser so the widget can be inspected; enabling a profile therefore has a
browser cost even on pages without its widget. `maxTier` still limits execution.

| Input | Meaning |
| --- | --- |
| `{ "value": ... }` | Explicit literal task parameter |
| `{ "selector": "...", "attribute": "..." }` | Unique element's attribute; without an attribute, its input value or text |
| `{ "selector": "...", "json": true }` | Parse the selected value as JSON |
| `{ "source": "global", "path": ["config", "key"] }` | Read a named page global; requires page CSP to allow the bridge |
| `{ "source": "url" }` / `{ "source": "userAgent" }` | Current browser URL / user agent |
| `{ "source": "screenshot", "selector": "..." }` | PNG crop of one element, at most 100 KB before Base64 encoding |
| `{ "source": "cookies" }` / `{ "source": "html" }` | Current-site cookies / page HTML; requires `allowSessionData: true` |

Where the task supports them, `websiteURL` and `userAgent` default to the current
browser values. A configured website URL must equal the current page URL.
`htmlPageBase64` from the HTML source is Base64 encoded. Inputs are checked against
the task's supported fields, types and required combinations. Incomplete tasks
are skipped. Profile task JSON is limited to 3 MB; provider responses to 512 KB.

Delivery paths are arrays indexing the provider's `solution` object; an empty
path selects the whole value. Use only the paths documented for that task:

- `fields`: unique input/textarea selectors and response paths. Values must be
  nonempty strings; TRAWL emits input/change events.
- `callback` and optional `callbackPath`: call a named function with one selected
  response value, including a structured object. Without a path, pass the whole
  solution. No arbitrary JavaScript is evaluated from configuration.
- `cookies`: an explicit name, response path and `format` (`value` or
  `set-cookie`). Cookies are restricted to the current URL. Provider-supplied
  Domain/Path attributes are discarded; unrelated domains cannot be updated.
- `clicks`: a unique target, response path and `mode`. `grid` uses one-based cell
  numbers with configured `rows` and `columns` (1-20 each). `coordinates` uses
  `{x,y}` values within the PNG identified by `imageInput`, scaled to the target's
  browser bounds. At most 32 clicks are applied. Drawing, dragging and rotation
  responses need a target-specific callback or field adapter.
- `submitSelector`: optional explicit submission after fields/clicks, restricted
  to the widget or its surrounding form. Use a callback or submit selector, not
  both. Submission is never inferred.
- `reload`: optionally reload after installing cookies or values.
- `verifySelector`: required unique visible success element, initially absent or
  hidden. TRAWL waits for this state within the remaining request budget. Choose
  an element that appears only after server acceptance; a cosmetic UI change is
  not independent verification.

The complete task is read again before delivery. Changed challenge parameters,
page navigation while waiting, missing targets and incompatible returned browser
identities reject the response. Dynamic image grids that replace themselves
mid-task need a new attempt; the request-wide task allowance still applies.

Native results include `captchaDiagnostics` with provider kind and status such as
`profile-required`, `incomplete-profile`, `ready`, `verified`, `delivery-failed`,
`identity-mismatch`, `provider-failed` or `cancelled`. The diagnostics contain no
parameters or credentials. Verified profiles appear in `captchasSolved` as
`<kind>:2captcha`. The Prowlarr response shape remains unchanged.

For supported widgets, local solving receives at most half the remaining widget
budget, capped by the local timeout setting. Disabling the provider preserves the
original local budget. The external phase polls at five-second intervals and does
not extend `maxTimeout`. No paid task is created when five seconds or less remain;
other short scrape budgets may still expire before workers finish.
Increase `maxTimeout` within the API's supported limits when needed.
Temporary polling failures receive at most two consecutive retries for the same
task, five seconds apart. Reloading or navigating the page while waiting aborts
delivery, and changed widget parameters reject the returned token.

An explicit HTTP, SOCKS4 or SOCKS5 browser proxy is passed to the provider instead
of silently switching to a proxyless task. HTTPS proxy URLs are currently skipped
by this adapter. The provider must be able to reach the supplied proxy; local Tor
or Gluetun endpoints may not be reachable from its workers. Implicit VPN or Firefox
proxy preferences are not converted into provider proxy settings. Profiles must
select the proxy or proxyless task variant matching the actual browser route;
proxy-required tasks are skipped without an explicit supported proxy. Tasks with
no proxy variant are skipped when a browser proxy is configured.

Enabling this feature sends the full target URL, sitekey, supported widget
parameters, the reCAPTCHA browser user agent and explicit proxy credentials to 2Captcha. Browser session cookies
and page content are sent only by explicitly configured profile inputs with
`allowSessionData: true`. Image/audio tasks send their configured media. Provider API traffic uses the server's network
route, rather than the browser's per-context proxy. TRAWL does not log the API key,
provider error descriptions or returned token in this adapter.

Each creation attempt consumes the allowance even if the connection fails: the
provider may have created a billable task before the response was lost. TRAWL
never retries task creation automatically. Stopping a request cancels local
polling but cannot cancel or refund a task already accepted by the provider.
This is a task-count limit, not a deployment-wide spending cap.
No-slot and HTTP 429 responses pause new external tasks for five seconds. Invalid
keys, zero balance and account/IP restrictions pause them for sixty seconds.
These cooldowns are shared by scrapes using the same provider configuration in
one process; local solving continues with its original budget during a cooldown.

Browser fixtures and the official task examples are tested without submitting
paid tasks. Real worker acceptance, latency, billing and success rates remain
unverified.

See the provider's [reCAPTCHA v2](https://2captcha.com/api-docs/recaptcha-v2),
[Turnstile](https://2captcha.com/api-docs/cloudflare-turnstile) and
[polling API](https://2captcha.com/api-docs/get-task-result) documentation.

## CAPTCHA audio and media tools

TRAWL uses ffmpeg while solving supported CAPTCHA challenges. reCAPTCHA audio is converted before
speech recognition, and the GeeTest solver uses it during image processing.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STT_URL` | — | Optional Whisper/OpenAI-compatible transcription endpoint |
| `STT_API_KEY` | — | Optional bearer token sent only to `STT_URL` |
| `FFMPEG_PATH` | `ffmpeg` | Executable name or absolute path used by the CAPTCHA solvers |

Without `STT_URL`, reCAPTCHA audio uses Google's public speech-recognition endpoint. When `STT_URL`
is configured, TRAWL sends a multipart `whisper-1` transcription request and adds
`Authorization: Bearer <STT_API_KEY>` when a key is present.

The API container already includes ffmpeg. Bare-metal installations must make `ffmpeg` available on
`PATH` or set `FFMPEG_PATH`. These values are read only by CAPTCHA solving; ordinary scrapes do not
contact the configured STT service. Treat `STT_API_KEY` as a secret and avoid committing it to `.env`.

## Proxies

### `PROXY_URL`

These environment-level proxies are escalation pools: direct Tier 1 and cached Tier 2 may complete before they are used. In contrast, the API request-level `proxy` field is a routing guarantee; target traffic for that request never falls back to a direct connection.

**Default:** _(empty — no proxy)_

Datacenter proxy pool used for Tier 3 (fresh challenge solve). TRAWL passes these endpoints to the
browser and supports HTTP and SOCKS5 forms:

```ini
PROXY_URL=http://dc-proxy.example.com:8080
PROXY_URL=http://user:pass@dc-proxy.example.com:8080
PROXY_URL=socks5://dc-proxy.example.com:1080
```

SOCKS5 destination hostnames are resolved by the proxy rather than the TRAWL host. This avoids
local DNS leaks and allows the proxy resolver to reach domains blocked or poisoned by the local
network. Use the standard `socks5://` form shown above; `socks5h://` is a curl-specific spelling and
is not accepted by the browser API.

HTTP credentials can be embedded in the URL. For multiple endpoints, use a comma-separated list:

```ini
PROXY_URL=http://user:pass@dc1.example.com:8080,http://user:pass@dc2.example.com:8080
```

Leave empty to run Tier 3 without a proxy (your server's real IP is used).

### `RESIDENTIAL_PROXY_URL`

**Default:** _(empty — Tier 4 disabled)_

Residential proxy pool used for Tier 4 (when the datacenter IP is flagged). Same format as `PROXY_URL` — single URL or comma-separated list. Tier 4 is completely skipped if this variable is not set and no per-request `proxy` override is supplied.

```ini
RESIDENTIAL_PROXY_URL=http://user:pass@residential.example.com:8080
RESIDENTIAL_PROXY_URL=socks5://residential.example.com:1080
```

Provider labels such as "rotating", "sticky", "country", or "session" do not change the TRAWL
format. Use the hostname, port, and credentials supplied by the provider.

### `PROXY_LIST_FILE` / `RESIDENTIAL_PROXY_LIST_FILE`

**Default:** _(empty)_

Alternative to cramming a large proxy list into `PROXY_URL`/`RESIDENTIAL_PROXY_URL` — path to a file with one proxy URL per line (`#` comments allowed). Merged with the corresponding `*_URL` env var if both are set.

```ini
PROXY_LIST_FILE=/etc/trawl/datacenter-proxies.txt
RESIDENTIAL_PROXY_LIST_FILE=/etc/trawl/residential-proxies.txt
```

Example file:

```text
# /etc/trawl/residential-proxies.txt
http://user:pass@residential-1.example.com:8080
http://user:pass@residential-2.example.com:8080
socks5://residential-3.example.com:1080
```

When using Docker, the path is inside the TRAWL container. Mount the file and pass the same
in-container path:

```yaml
services:
  trawl:
    environment:
      RESIDENTIAL_PROXY_LIST_FILE: /etc/trawl/residential-proxies.txt
    volumes:
      - ./residential-proxies.txt:/etc/trawl/residential-proxies.txt:ro
```

For a single endpoint or a short pool, a local `.env` beside `docker-compose.yml` is enough:

```ini
RESIDENTIAL_PROXY_URL=http://user:pass@residential.example.com:8080
```

The supplied Compose files pass the proxy pool sources and selection policy into the container.

### Rotation and failure handling

`SCRAPE_PROXY_SELECTION` controls how both datacenter and residential pools choose an endpoint:

| Value | Behavior |
| --- | --- |
| `failover` (default) | Keeps a proxy sticky per domain. New domains spread round-robin, and a domain moves only after its proxy is blocked. This best preserves IP continuity for challenge-heavy targets. |
| `roundrobin` | Chooses the next healthy endpoint whenever a request enters Tier 3 or Tier 4, including repeat requests to the same hostname. |
| `random` | Randomly chooses a healthy endpoint whenever a request enters Tier 3 or Tier 4. |

Selection happens only when a request actually reaches a proxy-backed tier. A request completed by
Tier 1 or cached Tier 2 does not advance the pool; use `SCRAPE_MIN_TIER=3` when every scrape must
enter proxy selection. The setting rotates configured endpoints, not the exit IP behind a single
provider-managed rotating gateway. Rotation state is local to each TRAWL process and is not
coordinated across replicas.

The selected proxy stays fixed for the whole tier attempt, including a headful retry. If an attempt
comes back `"blocked"`, the endpoint enters a 5-minute cooldown and that request retries once with
the next available proxy before falling through (Tier 3 → Tier 4, or Tier 4 failing outright). The
two-attempt limit prevents a large list from exhausting the request's `maxTimeout`.

### Per-request override

Both `POST /scrape` and `POST /v1` accept an optional `proxy` field in the request body — when present, it's used directly for that request's Tier 3/4 attempts instead of the configured pool (and isn't retried against other pool proxies on failure, since it's caller-supplied):

```json
{ "url": "https://example.com", "proxy": "http://user:pass@my-proxy.example.com:8080" }
```

Note: `proxy` on `/v1` is a TRAWL-specific extension — it is not part of the real FlareSolverr v2 contract, so other FlareSolverr-compatible clients simply won't send it.

### Test an endpoint

Test an HTTP proxy independently before starting TRAWL:

```bash
curl --proxy http://user:pass@proxy.example.com:8080 https://api.ipify.org
```

For SOCKS5, use curl's `socks5h://` spelling to test the same proxy-side DNS behavior TRAWL enables
in Firefox:

```bash
curl --proxy socks5h://proxy.example.com:1080 https://api.ipify.org
```

Use the provider's exact endpoint and authentication details. A working `curl` test confirms
connectivity, but the destination can still reject that proxy IP during a browser challenge.

## Ports

### `PORT`

**Default:** `8191`

API listener port. It defaults to `8191`, the same port used by FlareSolverr and Byparr.
The supplied Compose files use `${PORT:-8191}` for the host side of the `8191` container mapping.

To run TRAWL alongside FlareSolverr (or any other service that already binds `8191` on the host), set `PORT` in your shell or `.env` to any free port **before** running `docker compose up`:

```bash
PORT=9191 docker compose up -d
# TRAWL reachable at http://localhost:9191, while port 8191 stays free for FlareSolverr.
```

## Forward proxy

The optional general HTTP/HTTPS proxy has its own listener, CA, tier cap, and debug settings.
See [Proxy Configuration](/proxy/configuration) for all `MITM_*` variables and deployment
examples.

---

The repository's [`.env.example`](https://github.com/germondai/trawl/blob/main/.env.example) is the
canonical copyable environment template.

::: warning Upgrading from an earlier release?
The configuration namespaces changed without legacy aliases. Follow the complete
[configuration migration table](/deployment/configuration-migration) before recreating the container.
:::

### Request deadlines and resource limits

`maxTimeout` is shared by HTTP fetching, waiting for a browser, navigation, challenge handling, CAPTCHA solving and requested captures. Expiry aborts HTTP/transcription, stops owned FFmpeg subprocesses and closes the request's page or temporary context. Cleanup is bounded separately (up to five seconds for a page/context); replacing an unhealthy browser may continue after the request has ended. An expired request does not start additional capture work.

`BROWSER_MAX_CONTENT_PROCESSES` is not a limit on all OS processes or threads: Firefox also runs network, extension and other helper processes, and isolates sites separately. `BROWSER_HARDWARE_CONCURRENCY` controls the CPU count reported to page scripts, not a CPU quota. A 1 GiB limit can still be exceeded by an unusually demanding page; use Docker resource limits and measure the target workload. Disabling ad blocking may reduce extension overhead while increasing page subresource traffic.

## Named browser sessions

`BROWSER_SESSION_MAX_ENTRIES` (default `4`) limits isolated contexts created through `/sessions` or `/v1` session commands. `BROWSER_SESSION_TTL_SECONDS` (default `3600`) expires idle sessions and frees their contexts. These settings are independent of the domain clearance cache and `REDIS_SESSION_TTL_SECONDS`.

Start with `BROWSER_SESSION_MAX_ENTRIES=1` on a small container. Multiple contexts retain more memory, even after their request pages close. Live sessions postpone count-based recycling and idle retirement; memory pressure and crash recovery can still invalidate them. See [Browser Sessions](/api-reference/browser-sessions).
