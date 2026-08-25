---
title: Configuration
description: All environment variables for TRAWL, with defaults and examples.
---

# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit before starting.

## Redis

### `REDIS_URL`

**Default:** `redis://localhost:6379`

Standard Redis connection URL — TRAWL's cache backend is Redis 8.8. When running inside Docker Compose use the service name:

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

### `BROWSER_CONTENT_PROCESSES`

**Default:** `2`

Caps Firefox content processes per pooled browser via the `dom.ipc.processCount` Firefox pref. Firefox's default of 8 lets thread count climb when Tier 3 / Tier 4 churn disposable contexts (see #13). The cap bounds the leak at the source without paying the recycle cost. Raise if specific targets fail with empty content (rare).

```ini
BROWSER_CONTENT_PROCESSES=2   # default - conservative cap, lowest RAM/CPU
BROWSER_CONTENT_PROCESSES=4   # raise if CF/Imperva challenges stall
```

### `BROWSER_HEADFUL_POOL_SIZE`

**Default:** `0` (disabled)

Browsers in the headful sub-pool. This pool runs behind an Xvfb virtual display and serves
only DataDome escalations: DataDome reads headless signals directly and fails its Device
Check whatever the fingerprint says, while Cloudflare, Akamai, Imperva and DDoS-Guard all
resolve headless. The main pool stays headless, which is faster, and only the requests that
need a display pay for one.

Set it to `1` to scrape DataDome targets. It is off by default because the sub-pool is
**additional to `BROWSER_POOL_SIZE`**: one headful browser plus its X display measures about
380 MB (a headful browser is roughly twice a headless one, and Xvfb adds ~65 MB), so leaving
it on would move the memory ceiling of deployments that never meet DataDome. Account for it
in `mem_limit` before enabling.

The sub-pool is warmed on the first DataDome escalation, not at startup, so it costs nothing
until a DataDome target appears. That first request pays the browser cold start (~1s).
Readiness at `/health` reports the main pool only; the sub-pool appears under `headful` at
`/stats`, and reads `null` while disabled.

With the sub-pool disabled, DataDome escalations run on the headless pool and are expected
to fail with `datadome-persistent`.

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

## Session Cache

### `SESSION_TTL_SECONDS`

**Default:** `3600` (1 hour)

How long solved browser cookies and user-agent state are cached in Redis per domain. After this TTL
the next protected request triggers a fresh challenge solve (Tier 3) and refreshes the cache.

Cloudflare's `cf_clearance` cookie typically has a 30-minute expiry. Setting `SESSION_TTL_SECONDS` below 1800 wastes cache hits; setting it above 7200 risks replaying expired cookies (TRAWL handles this gracefully by invalidating the cache and falling back to Tier 3).

```ini
SESSION_TTL_SECONDS=3600   # default — safe for most sites
SESSION_TTL_SECONDS=1800   # more conservative
```

## Proxies

### `PROXY_URL`

**Default:** _(empty — no proxy)_

Datacenter proxy pool used for Tier 3 (fresh challenge solve). TRAWL passes these endpoints to the
browser and supports HTTP and SOCKS5 forms:

```ini
PROXY_URL=http://dc-proxy.example.com:8080
PROXY_URL=http://user:pass@dc-proxy.example.com:8080
PROXY_URL=socks5://dc-proxy.example.com:1080
```

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

The supplied Compose files pass all four proxy variables into the container.

### Rotation and failure handling

When more than one proxy is configured, TRAWL picks proxies **sticky-per-domain** — repeat requests to the same hostname keep reusing the same proxy (helps avoid re-triggering challenges), while different domains spread round-robin across the pool. If a tier attempt comes back `"blocked"` using a pool-sourced proxy, that proxy is put in a 5-minute cooldown and the request retries once with the next available proxy before falling through (Tier 3 → Tier 4, or Tier 4 failing outright) — bounded to 2 attempts per tier so a long list can't blow the request's `maxTimeout`.

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

For SOCKS5 with proxy-side DNS resolution:

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
See [Proxy Configuration](/proxy/configuration) for all `MITM_PROXY_*` variables and deployment
examples.

---

The repository's [`.env.example`](https://github.com/germondai/trawl/blob/main/.env.example) is the
canonical copyable environment template.
