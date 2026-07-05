---
title: Configuration
description: All environment variables for TRAWL, with defaults and examples.
---

# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit before starting.

## Redis

### `REDIS_URL`

**Default:** `redis://localhost:6379`

Standard Redis connection URL. When running inside Docker Compose use the service name:

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

## Session Cache

### `SESSION_TTL_SECONDS`

**Default:** `3600` (1 hour)

How long Cloudflare cookies are cached in Redis per domain. After this TTL the next request to the domain triggers a fresh challenge solve (Tier 3) and refreshes the cache.

Cloudflare's `cf_clearance` cookie typically has a 30-minute expiry. Setting `SESSION_TTL_SECONDS` below 1800 wastes cache hits; setting it above 7200 risks replaying expired cookies (TRAWL handles this gracefully by invalidating the cache and falling back to Tier 3).

```ini
SESSION_TTL_SECONDS=3600   # default — safe for most sites
SESSION_TTL_SECONDS=1800   # more conservative
```

## Proxies

### `PROXY_URL`

**Default:** _(empty — no proxy)_

Datacenter proxy pool used for Tier 3 (fresh challenge solve). Format: `protocol://user:pass@host:port`, or a **comma-separated list** for multiple proxies:

```ini
PROXY_URL=http://user:pass@dc-proxy.example.com:8080
PROXY_URL=http://user:pass@dc1.example.com:8080,http://user:pass@dc2.example.com:8080
```

Leave empty to run Tier 3 without a proxy (your server's real IP is used).

### `RESIDENTIAL_PROXY_URL`

**Default:** _(empty — Tier 4 disabled)_

Residential proxy pool used for Tier 4 (when the datacenter IP is flagged). Same format as `PROXY_URL` — single URL or comma-separated list. Tier 4 is completely skipped if this variable is not set and no per-request `proxy` override is supplied.

```ini
RESIDENTIAL_PROXY_URL=http://user:pass@residential.example.com:8080
```

### `PROXY_LIST_FILE` / `RESIDENTIAL_PROXY_LIST_FILE`

**Default:** _(empty)_

Alternative to cramming a large proxy list into `PROXY_URL`/`RESIDENTIAL_PROXY_URL` — path to a file with one proxy URL per line (`#` comments allowed). Merged with the corresponding `*_URL` env var if both are set.

```ini
PROXY_LIST_FILE=/etc/trawl/datacenter-proxies.txt
RESIDENTIAL_PROXY_LIST_FILE=/etc/trawl/residential-proxies.txt
```

### Rotation and failure handling

When more than one proxy is configured, TRAWL picks proxies **sticky-per-domain** — repeat requests to the same hostname keep reusing the same proxy (helps avoid re-triggering challenges), while different domains spread round-robin across the pool. If a tier attempt comes back `"blocked"` using a pool-sourced proxy, that proxy is put in a 5-minute cooldown and the request retries once with the next available proxy before falling through (Tier 3 → Tier 4, or Tier 4 failing outright) — bounded to 2 attempts per tier so a long list can't blow the request's `maxTimeout`.

### Per-request override

Both `POST /scrape` and `POST /v1` accept an optional `proxy` field in the request body — when present, it's used directly for that request's Tier 3/4 attempts instead of the configured pool (and isn't retried against other pool proxies on failure, since it's caller-supplied):

```json
{ "url": "https://example.com", "proxy": "http://user:pass@my-proxy.example.com:8080" }
```

Note: `proxy` on `/v1` is a TRAWL-specific extension — it is not part of the real FlareSolverr v2 contract, so other FlareSolverr-compatible clients simply won't send it.

## Ports

### `PORT`

**Default:** `8191`

Host port the Docker port mapping forwards to TRAWL's internal listener. Defaults to `8191` — the same port FlareSolverr and Byparr use, so you can swap TRAWL in without changing any *arr app settings. The container itself always listens on `8191` internally; `PORT` only changes the **host-side** port (e.g. `"${PORT:-8191}:8191"` in every compose file).

To run TRAWL alongside FlareSolverr (or any other service that already binds `8191` on the host), set `PORT` in your shell or `.env` to any free port **before** running `docker compose up`:

```bash
PORT=9191 docker compose up -d
# TRAWL reachable at http://localhost:9191, while port 8191 stays free for FlareSolverr.
```

### `PORT_WEB`

**Default:** `3000`

Port the Nuxt landing page listens on.

---

## Full `.env.example`

```ini
# ── Redis ─────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ── Browser pool ──────────────────────────────
BROWSER_POOL_SIZE=3
BROWSER_ACQUIRE_TIMEOUT_MS=15000
SESSION_TTL_SECONDS=3600

# ── Proxies (optional, comma-separated lists) ─
PROXY_URL=
RESIDENTIAL_PROXY_URL=
PROXY_LIST_FILE=
RESIDENTIAL_PROXY_LIST_FILE=

# ── Ports ─────────────────────────────────────
PORT=8191
PORT_WEB=3000
```
