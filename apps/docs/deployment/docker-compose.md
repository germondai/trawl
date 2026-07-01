---
title: Docker Compose
description: Run TRAWL with Docker Compose — scraper only or full stack.
---

# Docker Compose

Four compose files live in the repo root, matching the setups shown on the landing page.

## Scraper only

### Minimal

`docker-compose.minimal.yml` — single service, no Redis. Fastest to get started, no session caching.

```bash
docker compose -f docker-compose.minimal.yml up -d
```

### Cached (default)

`docker-compose.yml` — scraper + Redis session cache. Repeat requests to the same domain return in ~500ms.

```bash
docker compose up -d
```

### Production

`docker-compose.prod.yml` — same as cached but with `restart: always`, a memory limit, and a healthcheck.

```bash
docker compose -f docker-compose.prod.yml up -d
```

```yaml
trawl:
  restart: always
  mem_limit: 3g
  environment:
    BROWSER_POOL_SIZE: 5
  healthcheck:
    test: wget -qO- http://localhost:8191/health
    interval: 30s
```

To update to the latest image:

```bash
docker compose pull && docker compose up -d
```

### Baseline (older CPUs / Synology NAS)

If your CPU doesn't support AVX2 — older Synology NAS units, Atom/Celeron-era hardware — override the image tag to `:baseline` in any compose file above. Nothing else changes:

```yaml
services:
  trawl:
    image: ghcr.io/germondai/trawl:baseline
    # ...rest of the service definition unchanged
```

::: tip
See [Standalone Containers → Older CPUs & Synology NAS](/deployment/standalone#older-cpus-synology-nas) for how to tell if you need this, and the [README](https://github.com/germondai/trawl#docker-images-one-ghcr-package-two-tags) for the full tag comparison.
:::

## Full stack

`docker-compose.full.yml` adds the landing page and docs on top of the scraper. Web and docs are built from source.

```bash
docker compose -f docker-compose.full.yml up -d
```

| Service | URL | Description |
|---------|-----|-------------|
| `trawl` | `localhost:8191` | Scraper API |
| `web`   | `localhost:3000` | Landing page |
| `docs`  | `localhost:3001` | Documentation |
| `redis` | internal | Session cache |

First run builds the web and docs images locally — takes a couple of minutes. Subsequent runs are fast (layers cached).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_POOL_SIZE` | `3` | Warm browser instances |
| `BROWSER_ACQUIRE_TIMEOUT_MS` | `15000` | How long `acquire()` polls for a free browser before returning HTTP 429 |
| `REDIS_URL` | `redis://redis:6379` | Redis connection (set automatically in compose) |
| `RESIDENTIAL_PROXY_URL` | — | Enables Tier 4 proxy escalation |

## Logs

```bash
docker compose logs -f trawl
docker compose logs -f redis
```

## Memory guide

| `BROWSER_POOL_SIZE` | Approx. RAM | Recommended host RAM |
|---------------------|-------------|----------------------|
| 1 | ~500 MB | 1 GB |
| 3 | ~1.2 GB | 2 GB |
| 5 | ~2 GB | 3 GB |
| 10 | ~4 GB | 6 GB |

Each Camoufox Firefox instance uses ~350–500 MB under load.

## Reverse proxy

To expose TRAWL over HTTPS, proxy port 8191. Set `proxy_read_timeout` longer than your `maxTimeout` — challenge solves can take up to 15s.

```nginx
server {
  listen 443 ssl;
  server_name trawl.yourdomain.com;

  location / {
    proxy_pass http://localhost:8191;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
  }
}
```
