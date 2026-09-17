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

Standard Redis connection URL — TRAWL's cache backend is Redis 8.8. Set a non-empty URL to enable
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

## Browser Pool

### `BROWSER_POOL_SIZE`

**Default:** `3`

Number of Camoufox Firefox instances to keep warm. Each instance uses ~350–500 MB RAM under load. Start conservative and raise if you need higher concurrency.

```ini
BROWSER_POOL_SIZE=1   # minimal (1 GB host RAM)
BROWSER_POOL_SIZE=3   # default — good for most self-hosted setups
BROWSER_POOL_SIZE=8   # high-throughput (6+ GB host RAM)
```

> **Note:** The API container sets `shm_size: 1gb` by default. If you raise `BROWSER_POOL_SIZE` above 5, also raise `shm_size` in your `docker-compose.yml` to at least `2gb`.

### `BROWSER_ACQUIRE_TIMEOUT_MS`

**Default:** `15000` (15 seconds)

How long `BrowserPool.acquire()` will poll for a free browser before rejecting with `PoolExhaustedError`. With `BROWSER_POOL_SIZE=3` and a typical Cloudflare challenge taking 5–8s per request, the 15s default lets a full burst of 10 concurrent requests drain without any 429s.

Lower it for fail-fast client feedback (Prowlarr will see 429s sooner and retry on its own). Raise it for very heavy upstream targets or when you've bumped `BROWSER_POOL_SIZE` higher.

```ini
BROWSER_ACQUIRE_TIMEOUT_MS=5000    # fail fast — 429s after 5s
BROWSER_ACQUIRE_TIMEOUT_MS=15000   # default — absorbs a full burst on pool=3
BROWSER_ACQUIRE_TIMEOUT_MS=30000   # tolerate longer queueing on slow targets
```

When the timeout fires, both `/v1` and `/scrape` return **HTTP 429** with the FlareSolverr v2 error envelope (not a 500).

### `BROWSER_RECYCLE_AFTER_CONTEXTS`

**Default:** `8`

How many Tier 3 or Tier 4 temporary contexts a pooled browser can create before TRAWL rolling-replaces the full browser process. Every context counts, regardless of whether the attempt succeeds, times out, errors, or is blocked. TRAWL warms one replacement while the existing browser remains available, installs it when the entry is idle, then closes the retired browser. This briefly raises the pool by one browser, and replacements are serialized pool-wide to bound that peak.

```ini
BROWSER_RECYCLE_AFTER_CONTEXTS=8   # default - replace after 8 Tier 3/4 contexts
BROWSER_RECYCLE_AFTER_CONTEXTS=0   # disable browser recycling entirely
```

### `BROWSER_MAX_CONTENT_PROCESSES`

**Default:** `2`

Caps Firefox content processes per pooled browser via the `dom.ipc.processCount` Firefox pref. Firefox's default of 8 lets thread count climb when Tier 3 / Tier 4 churn disposable contexts (see #13). The cap bounds the leak at the source without paying the recycle cost. Raise if specific targets fail with empty content (rare).

```ini
BROWSER_MAX_CONTENT_PROCESSES=2   # default - conservative cap, lowest RAM/CPU
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
| `FAVICON_MAX_BYTES` | `524288` | Largest single icon kept. A body declaring more via `Content-Length`, and an inline `data:` href too long to decode within it, are refused before they are read |
| `FAVICON_FETCH_TIMEOUT_MS` | `5000` | Maximum wait for one icon |
| `FAVICON_TIMEOUT_MS` | `20000` | Ceiling on the whole collection; the request's own remaining `maxTimeout` also caps it, and collection is skipped once that budget is spent |

An icon that could not be read is returned with `error` set rather than dropped, and a
collection failure leaves `favicons` empty and never fails the scrape.

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
