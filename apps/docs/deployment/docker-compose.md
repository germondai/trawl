---
title: Docker Compose
description: Run TRAWL with the supplied minimal, cached, or production Docker Compose setup.
---

# Docker Compose

Three Compose files live in the repository root.

## Scraper only

### Minimal

`docker-compose.minimal.yml` — single service, no Redis. Fastest to get started, no session caching.

```bash
docker compose -f docker-compose.minimal.yml up -d
```

### Cached (default)

`docker-compose.yml` — scraper + Redis session cache, with API port `8191` and optional proxy port
`8192`. Repeat requests can reuse accepted sessions instead of solving the challenge again.

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
    BROWSER_POOL_SIZE: 1
  healthcheck:
    test: ["CMD", "curl", "-sf", "http://localhost:8191/health"]
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

## Run as a non-root user

The image defaults to root for backwards compatibility, but supports an explicit numeric UID and
GID. Camoufox and uBlock Origin are included under the read-only `/opt/camoufox` tree, while browser
profiles and other temporary files use the writable `/tmp` directory.

```yaml
services:
  trawl:
    image: ghcr.io/germondai/trawl:latest
    user: "1001:1001"
    volumes:
      - trawl_proxy_ca:/data/proxy-ca
```

The user must be able to write to the persistent CA volume. For a new named volume, initialize its
ownership once before starting TRAWL:

```bash
docker run --rm -v trawl_proxy_ca:/data/proxy-ca alpine \
  chown -R 1001:1001 /data/proxy-ca
```

Use the actual Compose-prefixed volume name shown by `docker volume ls` if it differs from
`trawl_proxy_ca`. Bind mounts must likewise be owned by the configured UID/GID. Without write
access, the MITM proxy cannot create or reuse its CA certificate and private key.

For a read-only container filesystem, provide a writable tmpfs for browser profiles and keep the CA
volume writable:

```yaml
services:
  trawl:
    image: ghcr.io/germondai/trawl:latest
    user: "1001:1001"
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - trawl_proxy_ca:/data/proxy-ca
```

No supported persistent application data is stored in `/tmp`; sessions and cookies are managed by
TRAWL and Redis.

## Environment variables

| Variable                         | Default              | Description                                                             |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `BROWSER_POOL_SIZE`              | `1`                  | Warm browsers; raise only for concurrent browser solves                  |
| `BROWSER_ACQUIRE_TIMEOUT_MS`     | `15000`              | How long `acquire()` polls for a free browser before returning HTTP 429 |
| `BROWSER_RECYCLE_AFTER_CONTEXTS` | `8`                  | Rolling-replace after this many Tier 3/4 contexts; `0` disables it      |
| `BROWSER_MAX_CONTENT_PROCESSES`  | `2`                  | Maximum Firefox content processes per browser                           |
| `SCRAPE_MIN_TIER`                | `1`                  | Lowest scraper tier allowed across every endpoint                       |
| `SESSION_CACHE_DRIVER`           | `redis`              | Cache backend; minimal Compose defaults to `memory`                      |
| `REDIS_URL`                      | `redis://redis:6379` | Redis connection (set automatically in compose)                         |
| `REDIS_SESSION_TTL_SECONDS`      | `3600`               | Lifetime of cached sessions                                             |
| `MEMORY_SESSION_CACHE_MAX_ENTRIES` | `1000`             | Maximum LRU-bounded entries for the memory driver                       |
| `REDIS_CONNECT_TIMEOUT_MS`       | `5000`               | Maximum time for each Redis connection attempt                          |
| `REDIS_RETRY_DELAY_MS`           | `5000`               | Background reconnect delay; `0` disables retry                          |
| `SCRAPE_PROXY_SELECTION`         | `failover`           | Pool policy: `failover`, `roundrobin`, or `random`                       |
| `PROXY_URL`                      | —                    | Optional Tier 3 datacenter proxy or pool                                |
| `RESIDENTIAL_PROXY_URL`          | —                    | Enables Tier 4 proxy escalation                                         |
| `MITM_ENABLED`                   | `false`              | Starts the general HTTP/HTTPS proxy                                     |
| `MITM_PORT`                      | `8192`               | Proxy listen and published port                                         |
| `MITM_HOST`                      | `0.0.0.0`            | Proxy bind address                                                      |
| `MITM_CA_DIR`                    | `/data/proxy-ca`     | Persistent root CA directory                                            |
| `MITM_ALWAYS_SCRAPE`             | `false`              | Skip proxy Tier 0 and enter the scraper immediately                     |
| `MCP_ENABLED`                    | `false`              | Enables the Streamable HTTP endpoint at `/mcp`                          |
| `MCP_ALLOWED_ORIGINS`            | —                    | Comma-separated allowed browser origins                                 |

All supplied Compose files publish port `8192` and mount the `trawl_proxy_ca` volume. The listener
does not start until `MITM_ENABLED=true`. See [Proxy Configuration](/proxy/configuration).

All supplied Compose files also pass `SCRAPE_PROXY_SELECTION`, `PROXY_URL`, `PROXY_LIST_FILE`,
`RESIDENTIAL_PROXY_URL`, and `RESIDENTIAL_PROXY_LIST_FILE` from the local environment or `.env`
file. For a single residential endpoint:

```ini
# .env
RESIDENTIAL_PROXY_URL=http://user:pass@residential.example.com:8080
```

The files explicitly pass every supported TRAWL runtime variable, including browser, screenshot,
blocked-evidence, diagnostics, redirect, response-capture, STT, and ffmpeg tuning. Docker Compose uses `.env` for
interpolation but does not otherwise expose arbitrary host variables to the container. Inspect the
resolved values with `docker compose config` and see the
[configuration migration guide](/deployment/configuration-migration) when upgrading.

There are two deliberate routing exceptions. `PORT` changes the published host port while the API
continues listening on container port `8191`. The Redis-backed variants select their bundled
`redis` service by default. The minimal variant defaults to the bounded in-memory cache; set
`SESSION_CACHE_DRIVER=redis` with an external `REDIS_URL` to use Redis instead.

For supported endpoint formats, pools, and mounted list files, see
[Configuration → Proxies](/getting-started/configuration#proxies).

## Route TRAWL through Gluetun

To route all TRAWL traffic through a Gluetun VPN, share Gluetun's network namespace and wait for
its healthcheck before starting TRAWL. Because TRAWL no longer has its own network namespace,
publish both TRAWL ports on the `gluetun` service:

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun
    # Configure your VPN provider and credentials here.
    ports:
      - "8191:8191"
      - "8192:8192"

  trawl:
    image: ghcr.io/germondai/trawl:latest
    network_mode: service:gluetun
    shm_size: 1gb
    depends_on:
      gluetun:
        condition: service_healthy
```

Do not also publish `8191` or `8192` on `trawl`; Compose does not allow port publishing with
`network_mode: service:gluetun`. Gluetun routing applies to all outbound container traffic.
`PROXY_URL`, by contrast, is optional application-level proxy configuration used by TRAWL's
escalation tiers; it is not required to send the container through the VPN.

## Logs

```bash
docker compose logs -f trawl
docker compose logs -f redis
```

## Memory guide

| `BROWSER_POOL_SIZE` | Approx. RAM | Recommended host RAM |
| ------------------- | ----------- | -------------------- |
| 1                   | ~500 MB     | 1 GB                 |
| 3                   | ~1.2 GB     | 2 GB                 |
| 5                   | ~2 GB       | 3 GB                 |
| 10                  | ~4 GB       | 6 GB                 |

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
