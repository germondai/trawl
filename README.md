<h1 align="center">
  <a href="https://trawl.germondai.com" target="_blank">
    <img align="center" src="https://icons.germondai.com/icons?i=bun,elysia,firefox,nuxt,vitepress" /><br/><br/>
    <span>TRAWL</span>
  </a>
</h1>

## **Welcome** to <a href="https://trawl.germondai.com" target="_blank">**TRAWL**</a>! 👋

Self-hosted web scraping engine that bypasses any JS challenge & captcha.\
Support for: Cloudflare, Turnstile, Interstitial, reCAPTCHA, hCaptcha, GeeTest, Imperva (experimental).\
Much faster and more reliable FlareSolverr & Byparr alternative and drop-in replacement for your \*arr stack.

## Features

- **2-6x faster** - compared to FlareSolverr or Byparr it returns much faster with higher success rate
- **4-tier execution** - plain HTTP fetch → cached browser session → fresh CF solve → residential proxy
- **Native captcha solving** - CF Turnstile/Interstitial, reCAPTCHA v2 (free STT), hCaptcha, GeeTest v4 Slide
- **Camoufox Firefox** - fingerprint-patched at the C++/Juggler level; indistinguishable from a real browser
- **Session cache** - bypass cookies stored in Redis; repeat requests to the same domain return in ~500ms
- **FlareSolverr compatible** - works with Prowlarr, Jackett, Sonarr, and the full \*arr ecosystem out of the box
- **No external APIs required** - reCAPTCHA audio transcription uses Google's free STT endpoint by default

## Sponsors

<details open>
  <summary>View/Collapse All</summary>

  <table>
    <tr>
      <td width="30%" align="center" valign="middle">
        <a href="https://go.nodemaven.com/germondaiGitHub" target="_blank">
          <img width="720" height="300" alt="nodemaven" src="https://github.com/user-attachments/assets/5dbfaee7-7863-4a20-a4a0-eb9f7bf0a90a" />
        </a>
      </td>
      <td valign="middle">
        <b><a href="https://go.nodemaven.com/germondaiGitHub" target="_blank">NodeMaven</a></b> - The most reliable proxy provider with the Highest Quality IP on the market. Best solution for automation, web scraping, SEO research, and social media management.<br><br>
        <b>Why <a href="https://go.nodemaven.com/germondaiGitHub" target="_blank">NodeMaven</a>?</b><br>
        • 99.9% uptime<br>
        • Sticky sessions up to 7 days<br>
        • IP filtering: all proxies have fraud score <97%<br>
        • No KYC required<br>
        • Cashback on traffic - burn GB and earn up to 10% back<br><br>
        <b>Special codes for <a href="https://trawl.germondai.com" target="_blank">TRAWL</a> users:</b><br>
        • TRAWL35 - 35% off to Mobile and Residential Proxies<br>
        • TRAWL40 - 40% off to ISP (Static) Proxies
      </td>
    </tr>
    <tr>
      <td width="30%" align="center" valign="middle">
        <a href="https://www.swiftproxy.net/?code=ICOTZM44K" target="_blank">
          <img width="240" height="100" alt="swiftproxy" src="https://github.com/user-attachments/assets/d7112814-182b-46b9-b359-cf48ca69d4cc" />
        </a>
      </td>
      <td valign="middle">
        <b><a href="https://www.swiftproxy.net/?code=ICOTZM44K" target="_blank">Swiftproxy</a></b> - A global residential proxy provider offering 80M+ real residential IPs across 190+ countries and regions. Built for web scraping, browser automation, AI workflows, SEO monitoring, and multi-account management.<br><br>
        <b>Why <a href="https://www.swiftproxy.net/?code=ICOTZM44K" target="_blank">Swiftproxy</a>?</b><br>
        • Non-expiring residential traffic<br>
        • Rotating & sticky sessions<br>
        • HTTP, HTTPS & SOCKS5 support<br>
        • Country, state & city-level targeting<br>
        • 24/7 technical support<br><br>
        <b>Exclusive offer for <a href="https://trawl.germondai.com" target="_blank">TRAWL</a> users:</b><br>
        • PROXY90 - Get 10% OFF all proxy plans<br>
        • Free Trial Available
      </td>
    </tr>
  </table>
</details>

## Quick start

```bash
# Clone and configure
git clone https://github.com/germondai/trawl
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

## Docker images (one GHCR package, two tags)

| Image tag                          | Built from                     | Runtime                       | Use case                                                   |
| ---------------------------------- | ------------------------------ | ----------------------------- | ---------------------------------------------------------- |
| `ghcr.io/germondai/trawl:latest`   | `apps/api/Dockerfile`          | Bun 1.3.14 (modern, AVX2)     | Default — modern Linux amd64/arm64                         |
| `ghcr.io/germondai/trawl:baseline` | `apps/api/Dockerfile.baseline` | Bun 1.3.14 baseline (no AVX2) | Older CPUs / older kernels (Synology NAS, J4125, Atom-era) |

Both tags live on the same `ghcr.io/germondai/trawl` package — they share the registry but use different Dockerfile sources. Pick whichever tag fits your hardware:

```yaml
# Modern hardware (most users)
image: ghcr.io/germondai/trawl:latest

# Older CPUs without AVX2 / Synology / older kernels
image: ghcr.io/germondai/trawl:baseline
```

Synology note: many Synology NAS units (DSM 7.x on J4125 / older hardware) ship kernel 4.4.x, which Bun's modern runtime can't fully handle. Standard Bun requires kernel 5.1+ (5.6+ recommended); the baseline build degrades gracefully down to kernel 3.10. The `:baseline` tag is published for that case — **confirmed working** on a Synology DS920+ (Celeron J4125, DSM 7.3.2, kernel 4.4.302): the container starts cleanly, `/health` reports healthy, and it solves live Cloudflare challenges via `/v1` (see [#1](https://github.com/germondai/trawl/issues/1)). Published by independent GitHub Actions workflows (`.github/workflows/publish.yml`, `publish-baseline.yml`); tag-triggered releases push matching git tags (e.g. `v1.0.0` → `1.0.0`, `1.0.0-baseline` → `1.0.0-baseline`) and manual `workflow_dispatch` from `main` updates the rolling tag (`latest` and `baseline` respectively).

## Releases & versioning

TRAWL follows [Semantic Versioning](https://semver.org/). Pushing a `v`-prefixed git tag (e.g.
`v1.0.0`) triggers `publish.yml`, which builds and pushes the matching un-prefixed Docker tag
(`ghcr.io/germondai/trawl:1.0.0`) alongside a major-only tag (`:1`). `:latest` always tracks the
tip of `main`; `:sha-<shortsha>` images are pushed on every `main` commit regardless of tags.
See the [Releases page](https://github.com/germondai/trawl/releases) for the full version
history and [CHANGELOG.md](CHANGELOG.md) for what changed in each one.

To publish a specific past commit that had a major fix without waiting for the next tip-of-`main`
release, tag that exact SHA and push it — `publish.yml` builds off the tag ref, not off `main`'s
current tip:

```bash
git tag -a v1.0.1 <sha> -m "..."
git push origin v1.0.1
```

## Configuration

| Variable                         | Default                  | Description                                                                         |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `BROWSER_POOL_SIZE`              | `3`                      | Warm Camoufox Firefox instances                                                     |
| `BROWSER_ACQUIRE_TIMEOUT_MS`     | `15000`                  | How long `acquire()` polls for a free browser before HTTP 429 is returned           |
| `BROWSER_RECYCLE_AFTER_CONTEXTS` | `8`                      | Recycle a browser after this many `blocked`/`needs-js` outcomes; set `0` to disable |
| `BROWSER_CONTENT_PROCESSES`      | `2`                      | Cap Firefox content processes per browser (`dom.ipc.processCount`); lowers RAM/CPU  |
| `SESSION_TTL_SECONDS`            | `3600`                   | Redis session cache TTL (seconds)                                                   |
| `REDIS_URL`                      | `redis://localhost:6379` | Redis connection string                                                             |
| `RESIDENTIAL_PROXY_URL`          | —                        | Enables Tier 4 proxy escalation                                                     |
| `STT_URL`                        | —                        | Local Whisper endpoint for reCAPTCHA (optional)                                     |
| `PORT`                           | `8191`                   | API listen port                                                                     |

## Stack

Built on a modern, fast-by-default stack: Bun + Elysia for the API, Redis for caching,
Camoufox (hardened Firefox) for browser automation, and Nuxt for the web UI — no legacy
Node/Express baggage.

| Layer         | Technology                         |
| ------------- | ---------------------------------- |
| Runtime       | Bun                                |
| API           | Elysia                             |
| Browser       | Camoufox Firefox (via camoufox-js) |
| Session cache | Redis 8.8                          |
| Landing page  | Nuxt 4                             |
| Documentation | VitePress                          |

## License

[AGPL-3.0](LICENSE)

---

<p align="center">
    <span>Made with ❤️ by</span>
    <a href="https://github.com/germondai" target="_blank">@germondai</a>
</p>
