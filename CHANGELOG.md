# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **MITM forward-proxy mode** (`MITM_PROXY_ENABLED`) — a browser-backed HTTP(S) forward proxy.
  The FlareSolverr `/v1` contract only returns cookies + user-agent; clients like Prowlarr take
  those and re-fetch the target with their own HTTP stack, which is re-challenged on sites whose
  Cloudflare clearance is bound to the solving browser's connection fingerprint (e.g. 1337x) — no
  cookie is portable to a plain client. Point such a client's HTTP proxy at this instead and every
  request is transparently re-issued through the browser pool, returning the raw response bytes
  (so `.torrent`/binary downloads pass through intact, not just HTML). Terminates TLS with a
  self-generated CA (persisted to `MITM_PROXY_CA_DIR`, downloadable at `GET /proxy-ca.crt`) that
  you install into the client's trust store. New env: `MITM_PROXY_ENABLED`, `MITM_PROXY_PORT`
  (default 8192), `MITM_PROXY_CA_DIR`, `MITM_PROXY_MAX_TIER`, `MITM_PROXY_DEBUG`.

## [1.0.0] - 2026-07-10

### Changed
- Shared types (`BrowserHandle`, `BrowserFingerprint`, `SupportedMethod`) centralized instead of
  being duplicated per-package
- `packages/tiers` split into `tiers/` and `utils/`, deduplicating cookie and network-failure
  helpers; `apps/api`'s entrypoint split into `config`, `deps`, and `routes`, adding a proper
  root status route
- Evaluated switching the cache backend to [Dragonfly](https://www.dragonflydb.io/) and reverted:
  benchmarking showed Dragonfly only wins throughput when load is spread across multiple
  connections, but `packages/browser`'s `SessionCache` holds a single shared `RedisClient`
  connection for the process lifetime — so at TRAWL's actual access pattern, plain Redis is
  faster at every scale tested, regardless of `BROWSER_POOL_SIZE`. Docker Compose configs
  (`docker-compose.yml`, `.full.yml`, `.prod.yml`) now pin `redis:8.8-alpine`; the `redis`
  service name and `REDIS_URL` env var are unchanged from before the Dragonfly experiment.

### Added
- Landing page shows a live GitHub star count

## [0.7.0] - 2026-07-08

### Added
- Audio STT fallback for the hCaptcha solver

### Fixed
- JS-only challenge pages that only look like plain HTML now correctly escalate from Tier 1 to
  the browser tiers (#22, #23)

## [0.6.0] - 2026-07-08

### Added
- `BROWSER_RECYCLE_AFTER_CONTEXTS` env var (default `8`, set `0` to disable) bounds long-running
  browser process growth by recycling the pooled Camoufox/Firefox instance after a configurable
  number of Tier 3/Tier 4 temporary context creations
- `BROWSER_CONTENT_PROCESSES` env var (default `2`) caps Firefox content processes per pooled
  browser via the `dom.ipc.processCount` Firefox pref. Firefox's default of 8 lets thread count
  climb when Tier 3/Tier 4 churn disposable contexts (see #13). The cap bounds the leak at the
  source without needing to restart the browser.
- Browser fingerprints now randomize OS/screen/window per instance and match the HTTP
  `User-Agent` to the emulated platform

### Changed
- `BROWSER_RECYCLE_AFTER_CONTEXTS` no longer recycles preemptively after every N temporary
  contexts. The pool now recycles only when Tier 3 or Tier 4 returns a `blocked` / `needs-js`
  outcome, preserving cookies, `cf_clearance`, and warm fingerprint state across successful
  solves. This eliminates the HTTP-429 storm observed in single-browser setups where the
  previous "recycle every N uses" logic left the only browser `restarting=true` for ~13s during
  every recycle window (#17, thanks @CoolDotty)
- Tier detection now recognizes more block/error page variants; Tier 4 gains full captcha
  parity, with proxy/timing info surfaced in responses (#19, thanks @edasque)

### Fixed
- Missing `curl` in the API runtime image broke healthchecks (#20, #21)
- Missing GeoLite2 mmdb caused a GeoIP startup crash on boot; now baked into the image (#20, #21)

## [0.5.0] - 2026-07-06

### Added
- Native `method` + `body` support across all four scraper tiers — the
  `FlareSolverrRequest.cmd=request.post` body is now actually delivered upstream instead of
  being silently dropped (thanks @whoshoe for the original POST support)
- `ScrapeRequest.method` accepts the full standard verb set: `GET`, `POST`, `PUT`, `PATCH`,
  `DELETE`, `HEAD`, `OPTIONS`, `TRACE`, `QUERY` (RFC 9341). `CONNECT` is intentionally excluded
  (tunneling verb, inappropriate for a proxy)
- POST / `*` request bodies are forwarded **uncapped** — operators who want a byte ceiling
  should impose it at their ingress / fronting proxy
- Body-bearing requests require a `Content-Type` header; the tier functions no longer
  auto-inject `application/x-www-form-urlencoded`, which previously mislabelled JSON / XML
  bodies
- `ScrapeRequest` field renamed from `postData` → `body` for REST-idiomatic naming.
  (`FlareSolverrRequest.postData` is unchanged because it's the upstream wire contract.)
- Native Imperva/Incapsula WAF challenge detection and solving in Tier 3 and Tier 4
- Proxy rotator reworked into a sticky, failure-aware pool with per-request override support
- `PORT_API` env var renamed to `PORT` and made properly configurable (#9, #10)

### Security
- Reserved-name header denylist prevents callers from spoofing `cf_clearance` cookies,
  overriding the per-tier `User-Agent`, or rewriting routing signals (`X-Forwarded-For`, `Host`)
  during a POST bypass flow

### Fixed
- `/v1` now accepts Prowlarr's Cardigann `FlareSolverrProxy` object shape
  (`{url, username, password}`) for the per-request `proxy` field, instead of crashing with
  `proxy.server: expected string, got object` when Prowlarr sends it through (#12, #15). The
  boundary normalises both the object form and a plain URL string into a single URL string
  before the orchestrator forwards it to Playwright/Camoufox. Credentials are URL-encoded so
  embedded `@`/`:` characters survive the round-trip.

### Limitations
- The Playwright `page.route(url, …)` interceptor only handles the first top-frame GET to that
  exact URL. Server redirects to a different URL, XHR sub-resources, and chained `POST→POST`
  form flows do not have the `postData` override applied
- No idempotency-key support; transient network failures and pool churn can re-fire a POST
  (separate ticket)

### Tests
- `packages/tiers/tests/sanitize.test.ts` — header sanitiser, method allowlist, postData size
  cap, Content-Type enforcement
- `packages/tiers/tests/runTier1Post.test.ts` — tier1 GET/POST round-trip and User-Agent
  non-override
- Run via `bun --cwd packages/tiers test`

## [0.4.0] - 2026-07-01

### Added
- `:baseline` Docker image variant for pre-AVX2 CPUs and older kernels, published to its own
  GHCR tag — confirmed working on a Synology DS920+ (DSM 7.3.2, kernel 4.4.302), see #1

### Fixed
- Docker healthchecks failing, root-caused to `wget` vs. the runtime image; switched to a
  `curl`-based healthcheck with a proper timeout and start period (#3, #4)
- Startup crash loop (`EISDIR`, missing `memoirist`/`camoufox-js`) fixed by switching
  `bun install` to `--linker=hoisted` (#1, #6)
- `/health` now correctly returns 503 while the browser pool is still initializing

## [0.3.0] - 2026-06-30

### Added
- Configurable browser pool concurrency limiter to guard against OOM under burst load
- `BROWSER_ACQUIRE_TIMEOUT_MS` env var, default 15s

### Changed
- A saturated browser pool now returns HTTP 429 instead of a raw 500
- Default `BROWSER_POOL_SIZE` raised to 3

## [0.2.0] - 2026-06-26

### Added
- Custom `headers` field on `ScrapeRequest`, forwarded through Tier 1-4 via URL-scoped route
  interception and exposed on `/v1` and `/scrape` with CORS support
- `cmd` is now optional on `/v1`, defaulting to `request.get`

### Changed
- Multi-arch Docker publish now runs on native arm64 runners with a two-phase per-digest build
  and manifest merge

## [0.1.0] - 2026-06-26

### Added
- Initial release with 4-tier execution engine
- Native captcha solving for Cloudflare Turnstile, reCAPTCHA v2 (audio STT), hCaptcha (audio
  bypass), and GeeTest v3 slider
- Persistent browser pool with real Camoufox Firefox
- Session caching via Redis
- FlareSolverr v2-compatible `/v1` endpoint
- WebSocket live scrape streaming at `/scrape/live`
- Self-healing browser pool with automatic restart on crash
- Sticky domain routing to maximize session cache hits
- Nuxt 4 landing page with live stats
- VitePress documentation site
- Docker Compose deployment with amd64/arm64 platform targeting
