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

### Security
- Reserved-name header denylist prevents callers from spoofing `cf_clearance`
  cookies, overriding the per-tier `User-Agent`, or rewriting routing signals
  (`X-Forwarded-For`, `Host`) during a POST bypass flow

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
