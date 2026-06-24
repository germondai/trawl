<h1 align="center">
  <a href="https://trawl.dev" target="_blank">
    <img align="center" src="https://icons.germondai.com/icons?i=bun,elysia,firefox,redis,nuxt,vitepress" /><br/><br/>
    <span>TRAWL</span>
  </a>
</h1>

## **Welcome** to <a href="https://trawl.dev" target="_blank">**TRAWL**</a>! 👋

Self-hosted web scraping engine with adaptive tier execution. Solves Cloudflare challenges natively using [Camoufox](https://github.com/daijro/camoufox) Firefox. Returns cached results in under 500ms. Drop-in FlareSolverr v2 replacement.

## Features

- **4-tier execution** — plain HTTP → cached session → fresh CF solve → residential proxy
- **Native captcha solving** — CF Turnstile, reCAPTCHA v2 (free STT), hCaptcha, GeeTest v4 Slide
- **Camoufox Firefox** — fingerprint-patched at the C++/Juggler level; indistinguishable from a real browser
- **Session cache** — `cf_clearance` cookies stored in Redis; repeat requests to the same domain return in ~500ms
- **FlareSolverr v2 compatible** — works with Prowlarr, Jackett, Sonarr, Radarr, and the full \*arr ecosystem out of the box
- **No external APIs** — reCAPTCHA audio transcription uses Google's free STT endpoint by default; everything else is local

## Quick start

```bash
# Clone and configure
git clone https://github.com/germondai/trawl.git
cd trawl
cp .env.example .env

# Start scraper + Redis
docker compose up -d

# Verify
curl http://localhost:8191/health
```

First boot takes 15–30s while the browser pool warms up. Subsequent starts are fast.

## API

### FlareSolverr-compatible (`/v1`)

```bash
curl -X POST http://localhost:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://nowsecure.nl","maxTimeout":60000}'
```

### Native API (`/scrape`)

Returns richer metadata: `tier`, `timings`, `sessionCached`, full cookie list.

```bash
curl -X POST http://localhost:8191/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://nowsecure.nl","maxTimeout":60000}'
```

### Connect Prowlarr / Jackett

Set the FlareSolverr URL to:

```
http://localhost:8191        # running on the same host
http://trawl:8191            # running via Docker Compose on the same network
```

## Tiers

```
Request
  │
  ▼
Tier 1: Plain HTTP fetch ────── success ──→ return (< 100ms)
  │ blocked
  ▼
Tier 2: Cached session ─────── success ──→ return (~500ms)
  │ cache miss / expired
  ▼
Tier 3: Fresh CF solve ─────── success ──→ cache + return (4–15s)
  │ IP flagged
  ▼
Tier 4: Residential proxy ──── success ──→ cache + return (15–45s)
  │ failed
  ▼
  error
```

## Docker Compose files

| File                         | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `docker-compose.yml`         | Scraper + Redis (default)                                |
| `docker-compose.minimal.yml` | Scraper only, no Redis                                   |
| `docker-compose.prod.yml`    | Production: `restart: always`, memory limit, healthcheck |
| `docker-compose.full.yml`    | Full stack: scraper + web + docs                         |

## Configuration

| Variable                | Default                  | Description                                     |
| ----------------------- | ------------------------ | ----------------------------------------------- |
| `BROWSER_POOL_SIZE`     | `5`                      | Warm Camoufox Firefox instances                 |
| `SESSION_TTL_SECONDS`   | `3600`                   | Redis session cache TTL (seconds)               |
| `REDIS_URL`             | `redis://localhost:6379` | Redis connection string                         |
| `RESIDENTIAL_PROXY_URL` | —                        | Enables Tier 4 proxy escalation                 |
| `STT_URL`               | —                        | Local Whisper endpoint for reCAPTCHA (optional) |
| `PORT_API`              | `8191`                   | API listen port                                 |

## Stack

| Layer         | Technology                         |
| ------------- | ---------------------------------- |
| Runtime       | Bun                                |
| API           | Elysia                             |
| Browser       | Camoufox Firefox (via camoufox-js) |
| Session cache | Redis                              |
| Landing page  | Nuxt 4                             |
| Documentation | VitePress                          |

## License

[AGPL-3.0](LICENSE)

---

<p align="center">
    <span>Made with ❤️ by</span>
    <a href="https://github.com/germondai" target="_blank">@germondai</a>
</p>
