---
title: Quick Start
description: Get TRAWL running with Docker Compose in under two minutes.
---

# Quick Start

You need **Docker 24+** with the Compose plugin. That's the only prerequisite.

## 1. Clone the repository

```bash
git clone https://github.com/germondai/trawl.git
cd trawl
```

## 2. Create your `.env` file

```bash
cp .env.example .env
```

Everything has a working default. See [Configuration](/getting-started/configuration) for the full reference.

## 3. Start everything

```bash
docker compose up -d
```

This starts two containers:

| Container | Purpose                 | Port     |
| --------- | ----------------------- | -------- |
| `redis`   | Session cache backend   | internal |
| `trawl`   | Browser pool, API, and optional forward proxy | 8191, 8192 |

The API takes **15–30 seconds** to launch and warm the browser pool. Watch progress:

```bash
docker compose logs -f api
```

You'll see:
```
[api] TRAWL starting on :8191  (pool: 3 browsers)
[api] session cache connected  (Tier 2 fast-path enabled)
[pool] browser 1/3 ready
[pool] browser 2/3 ready
[pool] browser 3/3 ready
[api] ready — all 3 browsers warm
```

## 4. Verify it works

```bash
curl -s http://localhost:8191/health | jq
```

Expected:

```json
{
  "status": "ok",
  "uptime": 28,
  "pool": {
    "total": 3,
    "busy": 0,
    "available": 3,
    "restarts": 0,
    "avgRestarts": 0,
    "stalled": 0,
    "live": 3
  }
}
```

## 5. Send your first scrape request

```bash
curl -s -X POST http://localhost:8191/v1 \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": "request.get",
    "url": "https://nowsecure.nl",
    "maxTimeout": 60000
  }' | jq '{status, url: .solution.url}'
```

A `status: "ok"` response confirms TRAWL is working. Repeat requests can reuse the cached browser
session when the target still accepts it.

::: tip Challenge requests take longer
An unprotected target may finish in Tier 1 without opening a browser. A recognized Cloudflare,
AWS WAF, Akamai, or Imperva wall escalates to a fresh browser flow. Later requests can use Tier 2 while the
saved session remains valid.
:::

## 6. Use the native API (optional)

The `/scrape` endpoint returns a richer response than `/v1` — includes `tier`, `timings`, `sessionCached`, and more:

```bash
curl -s -X POST http://localhost:8191/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://nowsecure.nl"}' | jq '{tier, totalMs}'
```

## 7. Connect Prowlarr or Jackett (optional)

In Prowlarr → **Settings → Indexers → FlareSolverr**, set:

```
http://localhost:8191
```

Done. No other configuration changes are needed. TRAWL implements the FlareSolverr v2 API exactly.

---

## What's running

```
localhost:8191  →  TRAWL API  (FlareSolverr-compatible + native endpoint)
localhost:8192  →  HTTP/HTTPS forward proxy (when MITM_PROXY_ENABLED=true)
```

To stop everything:

```bash
docker compose down
```

To stop and wipe the session cache:

```bash
docker compose down -v
```
