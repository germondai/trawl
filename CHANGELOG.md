# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release with 4-tier execution engine
- Native `method` + `body` support across all four scraper tiers — the
  `FlareSolverrRequest.cmd=request.post` body is now actually delivered upstream
  instead of being silently dropped
- Header sanitisation at the API + orchestrator boundary: caller-supplied
  `Host`, `Cookie`, `Authorization`, `X-Forwarded-*`, `Sec-*`, `User-Agent`,
  `Content-Length`, and similar reserved headers are dropped before being
  forwarded to Node fetch / Playwright
- `ScrapeRequest.method` accepts the full standard verb set: `GET`, `POST`,
  `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `TRACE`, `QUERY` (RFC 9341).
  `CONNECT` is intentionally excluded (tunneling verb, inappropriate for a
  proxy)
- POST / `*` request bodies are forwarded **uncapped** — operators who want a
  byte ceiling should impose it at their ingress / fronting proxy
- Body-bearing requests require a `Content-Type` header; the tier functions no
  longer auto-inject `application/x-www-form-urlencoded`, which previously
  mislabelled JSON / XML bodies
- `ScrapeRequest` field renamed from `postData` → `body` for REST-idiomatic
  naming. (`FlareSolverrRequest.postData` is unchanged because it's the
  upstream wire contract.)
- `BROWSER_RECYCLE_AFTER_CONTEXTS` env var (default `8`, set `0` to disable)
  bounds long-running browser process growth by recycling the pooled
  Camoufox/Firefox instance after a configurable number of Tier 3/Tier 4
  temporary context creations. Some Camoufox/Firefox builds retain child
  content processes after `context.close()`, which on shared hosts with
  strict `ulimit -u` can push per-user thread counts toward the cap while
  `/health` still reports the pool as available. Recycling returns the OS
  to a clean state without dropping Redis-backed session cache entries.
- `BROWSER_CONTENT_PROCESSES` env var (default `2`) caps Firefox content
  processes per pooled browser via the `dom.ipc.processCount` Firefox
  pref. Firefox's default of 8 lets thread count climb when Tier 3/Tier 4
  churn disposable contexts (see #13). The cap bounds the leak at the
  source without needing to restart the browser.

### Changed
- Default cache backend switched from Redis to [Dragonfly](https://www.dragonflydb.io/)
  in all Docker Compose configs (`docker-compose.yml`, `.full.yml`, `.prod.yml`).
  Dragonfly is Redis-protocol compatible, so `packages/browser`'s session cache
  (Bun's native `RedisClient`) needs no code changes. The compose service is
  renamed `redis` → `dragonfly`; the `REDIS_URL` env var name is unchanged.
- `BROWSER_RECYCLE_AFTER_CONTEXTS` no longer recycles preemptively after
  every N temporary contexts. The pool now recycles only when Tier 3 or
  Tier 4 returns a `blocked` / `needs-js` outcome, preserving cookies,
  `cf_clearance`, and warm fingerprint state across successful solves.
  This eliminates the HTTP-429 storm observed in single-browser setups
  where the previous "recycle every N uses" logic left the only browser
  `restarting=true` for ~13s during every recycle window. See #17.

### Security
- Reserved-name header denylist prevents callers from spoofing `cf_clearance`
  cookies, overriding the per-tier `User-Agent`, or rewriting routing signals
  (`X-Forwarded-For`, `Host`) during a POST bypass flow

### Fixed
- `/v1` now accepts Prowlarr's Cardigann `FlareSolverrProxy` object shape
  (`{url, username, password}`) for the per-request `proxy` field, instead of
  crashing with `proxy.server: expected string, got object` when Prowlarr sends
  it through (issue #12). The boundary normalises both the object form and a
  plain URL string into a single URL string before the orchestrator forwards
  it to Playwright/Camoufox. Credentials are URL-encoded so embedded `@`/`:`
  characters survive the round-trip.

### Limitations
- The Playwright `page.route(url, …)` interceptor only handles the first
  top-frame GET to that exact URL. Server redirects to a different URL, XHR
  sub-resources, and chained `POST→POST` form flows do not have the
  `postData` override applied
- No idempotency-key support; transient network failures and pool churn can
  re-fire a POST (separate ticket)

### Tests
- `packages/tiers/tests/sanitize.test.ts` — header sanitiser, method
  allowlist, postData size cap, Content-Type enforcement
- `packages/tiers/tests/runTier1Post.test.ts` — tier1 GET/POST round-trip and
  User-Agent non-override
- Run via `bun --cwd packages/tiers test`
- Persistent browser pool with real Google Chrome
- Session caching via Redis
- FlareSolverr v2-compatible `/v1` endpoint
- WebSocket live scrape streaming at `/scrape/live`
- Self-healing browser pool with automatic restart on crash
- Sticky domain routing to maximize session cache hits
- Nuxt 4 landing page with live stats
- VitePress documentation site
- Docker Compose deployment with amd64 platform targeting for Chrome compatibility
