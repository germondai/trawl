---
title: Standalone Containers
description: Build and run each TRAWL service as an individual Docker container.
---

# Standalone Containers

Each service has its own Dockerfile and can be built and run independently.

## Scraper API

The API image is published to GHCR on every push to `main`. Pull it directly — no local build needed.

```bash
# Pull
docker pull ghcr.io/germondai/trawl:latest

# Run (no Redis — session caching disabled, scraping still works)
docker run -d \
  --name trawl \
  -p 8191:8191 \
  --shm-size=1gb \
  ghcr.io/germondai/trawl:latest

# Run (with external Redis)
docker run -d \
  --name trawl \
  -p 8191:8191 \
  --shm-size=1gb \
  -e REDIS_URL=redis://your-redis-host:6379 \
  -e BROWSER_POOL_SIZE=3 \
  ghcr.io/germondai/trawl:latest
```

### Older CPUs & Synology NAS

If your host CPU doesn't support AVX2 — older Synology NAS units, Atom/Celeron-era hardware, pre-2013 x86_64 — use the `:baseline` tag instead. Same image, same commands, built on Bun's baseline runtime.

```bash
# Pull
docker pull ghcr.io/germondai/trawl:baseline

# Run
docker run -d \
  --name trawl \
  -p 8191:8191 \
  --shm-size=1gb \
  ghcr.io/germondai/trawl:baseline
```

::: tip Not sure which tag you need?
Try `:latest` first. If the container exits immediately or crash-loops, switch to `:baseline` — it trades a little raw throughput for compatibility with older CPUs and kernels. Full tag comparison is in the [README](https://github.com/germondai/trawl#docker-images-one-ghcr-package-two-tags).
:::

To build from source instead:

```bash
# Run from the repo root
docker build -f apps/api/Dockerfile -t trawl .
docker run -d --name trawl -p 8191:8191 --shm-size=1gb trawl
```

To build the baseline variant from source, use `apps/api/Dockerfile.baseline` instead:

```bash
docker build -f apps/api/Dockerfile.baseline -t trawl:baseline .
docker run -d --name trawl -p 8191:8191 --shm-size=1gb trawl:baseline
```

::: warning Build context
Both API Dockerfiles (`apps/api/Dockerfile` and `apps/api/Dockerfile.baseline`) require the **repo root** as the build context because they copy workspace packages (`packages/types`, `packages/browser`, `packages/tiers`). Always run `docker build` from the repo root with `-f apps/api/Dockerfile` (or `-f apps/api/Dockerfile.baseline`).
:::

::: tip Why pull instead of build?
Building the API image downloads the Camoufox Firefox binary (~660 MB) and compiles dependencies — takes 5–10 minutes on first run. The published image on GHCR skips all of that.
:::

## Web (landing page)

```bash
# Build — run from repo root
docker build -f apps/web/Dockerfile -t trawl-web .

# Run
docker run -d \
  --name trawl-web \
  -p 3000:80 \
  trawl-web
```

Static HTML served by nginx. No runtime dependencies.

## Docs

```bash
# Build — run from repo root
docker build -f apps/docs/Dockerfile -t trawl-docs .

# Run
docker run -d \
  --name trawl-docs \
  -p 3001:80 \
  trawl-docs
```

Access at `http://localhost:3001`. Static nginx, no runtime dependencies.

For subdomain deployment (e.g. `docs.yourdomain.com`), point the subdomain at port 3001 via your reverse proxy — no path configuration needed.

## Useful commands

Swap `:latest` for `:baseline` in any command below if you're on older/no-AVX2 hardware.

```bash
# Check what's running
docker ps

# Tail logs
docker logs -f trawl

# Stop and remove
docker stop trawl && docker rm trawl

# Update the scraper to latest
docker pull ghcr.io/germondai/trawl:latest
docker stop trawl && docker rm trawl
docker run -d --name trawl -p 8191:8191 --shm-size=1gb ghcr.io/germondai/trawl:latest
```
