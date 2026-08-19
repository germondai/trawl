# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **DataDome support.** Detect Device Check, slider CAPTCHA and `t=bv` hard blocks from challenge markers and `x-dd-b`. Device Check uses a dedicated waiter and an optional headful Xvfb pool; the slider is reported as `datadome-captcha-required`. Enable startup-warmed capacity with `BROWSER_HEADFUL_POOL_SIZE=1` (off by default).
- **AWS WAF Challenge support.** Detect the documented `202` Challenge and `405` CAPTCHA responses from their `x-amzn-waf-action` header, with a conservative two-marker HTML fallback. Silent challenges use a dedicated browser waiter for the domain-matching `aws-waf-token`; interactive CAPTCHA is surfaced as `aws-waf-captcha-required` for a future solver.
- Optional response-body capture: `captureResponses` on `POST /scrape` takes URL patterns (a substring, or a glob when the pattern contains `*` or `?`) and returns the matching responses' bodies in `ScrapeResult.capturedResponses`, so a page that ships an empty shell and loads its content over a background request is still readable. `settleTimeout` holds the page open after load waiting for a match and `waitForSelector` ends that window early. Off by default — without patterns no listener is attached. Pattern count, body count, per-body bytes and total bytes are bounded and tunable via `CAPTURE_*`; a body over its budget comes back trimmed and flagged `truncated`, a binary or unknown content type comes back base64, and a body that cannot be read carries its own `error` rather than failing the scrape.
- Optional console, network and redirect-chain capture: `consoleLogs`, `networkLogs` and `redirectChain` on `POST /scrape` return the page's console messages, per-request resource timings, and the URLs the main document walked (`ScrapeResult.consoleLogs` / `networkLogs` / `redirectChain`), captured by the browser tiers (2-4). Each flag is independent and off by default — without it no listener is attached and nothing is buffered. Entry counts, string lengths and total captured characters are bounded and tunable via `CAPTURE_*`; anything past a cap is dropped whole rather than truncated, and a capture failure leaves the field unset rather than failing the scrape.
- Optional viewport screenshot: `screenshot: true` on `POST /scrape` returns a base64 JPEG of the viewport in `ScrapeResult.screenshot`, captured by the browser tiers (2-4) immediately before the HTML read so image and markup describe the same moment. Off by default; a stock request attaches nothing and does no extra work. Settle wait, capture timeout, JPEG quality, and maximum image size are bounded and tunable via `SCREENSHOT_*`, and a capture failure leaves the field unset rather than failing the scrape.

### Fixed
- Wait for the bundled Redis service to pass a `PING` healthcheck before starting TRAWL, preventing a transient Compose startup race from disabling the Tier 2 session cache for the process lifetime (#90).
- Reap orphaned Camoufox processes in both API container variants by running Bun under Tini (#79).
- Preserve every upstream `Set-Cookie` field across direct, Tier 1, and browser-backed proxy responses, serializing each cookie as its own HTTP header instead of dropping or malformedly folding repeated values (#64).
- Treat an explicit request-level `proxy` as a strict routing guarantee: route HTTP(S) Tier 1 requests through it, skip direct Tier 1 for SOCKS, bypass the unproxied Tier 2 cache, prevent proxy-derived sessions from entering the shared domain cache, disable Firefox direct failover, and surface authentication, transport, protocol, and `Proxy-Status` failures as errors instead of successful content (#73).

## [1.4.2] - 2026-08-22

### Changed
- Bump all application and internal package versions to `1.4.2`.

### Fixed
- Detect and resolve DDoS-Guard JS interstitials without misclassifying them as Cloudflare challenges (#66).

## [1.4.1] - 2026-08-21

### Changed
- Bump all application and internal package versions to `1.4.1`.
- Update the container and development runtime to Bun 1.4.0, Biome to 2.5.10, Bun types to 1.4.0, Patchright to 1.62.1, Nuxt SEO to 5.3.14, and vue-tsc to 3.3.11.
- Update GeoLite2 City to 2026.08.19 after the previously pinned upstream release became unavailable.
- Keep Playwright Core on 1.60.0 for Camoufox compatibility and the Nuxt app on TypeScript 5.9.3 for vue-tsc compatibility; other workspaces use TypeScript 7.0.2.

### Fixed
- Remove the unused native TypeScript compiler from both production API images and fail image builds if a native `@typescript/typescript-*` artifact is present, eliminating its fixable HIGH runtime CVEs (#68).

## [1.4.0] - 2026-08-10

### Changed
- **Cold-start performance milestone:** TRAWL's complete first request, including browser launch, is now nearly **4x faster** in like-for-like Docker benchmarks. Redis validation and browser warmup now run concurrently, Tier 0 becomes available immediately, and browser capacity is published progressively. Warm-request timings vary with browser state, session caching, and challenge behavior and are not included in this cold-start comparison.
- Bump all application and internal package versions to `1.4.0`.
- Update Biome to 2.5.7, Memoirist to 1.2.2, Nuxt to 4.5.2, and Nuxt SEO to 5.3.11. TypeScript remains on 5.9.3 for the Nuxt app and Playwright remains on 1.60.0 for Camoufox compatibility.
- Update GitHub Actions to their current stable major releases and make the CI release gate read-only and reproducible.
- Pin the runtime to Bun 1.3.14, Camoufox v152.0.4-beta.28, GeoLite2 City 2026.08.07, and Redis 8.8.1, with SHA-256 verification for downloaded browser/runtime data assets.
- The remaining audit findings are confined to Nuxt/VitePress development and build-time dependency trees; no compatible upstream update is currently available for those transitive packages.

### Fixed
- Support explicit non-root Docker users by baking the pinned uBlock Origin addon into both API image variants and using a writable temporary home directory. Document CA volume ownership and read-only container requirements (#60).
- Reduce cold-start latency by warming Redis alongside the browser pool, publishing the first browser immediately, warming the remaining browsers concurrently, and accepting Tier 0 proxy traffic during warmup. Unavailable Redis now disables Tier 2 promptly instead of delaying the first request. Tier 0 also handles informational HTTP responses correctly and escalates authoritative `cf-mitigated: challenge` headers immediately.
- Keep browser-tier status, headers, content type, and raw body aligned with the latest main-frame navigation response across redirects, and prevent persistent Cloudflare challenges from being returned as successful rendered pages (#53).
- Translate Prowlarr's serialized `headers.contentType` metadata at the FlareSolverr `/v1` compatibility boundary and discard `contentLength`, allowing form POST requests to enter the scraper pipeline (#50).
- Bound Camoufox memory growth by counting every Tier 3/4 temporary context and rolling-replacing browsers at `BROWSER_RECYCLE_AFTER_CONTEXTS`, while keeping existing capacity available during warm-up. Replacement launches are serialized, cleanup is timeout-bounded, and failed launches retain the usable browser (#52).

## [1.3.1] - 2026-08-02

### Fixed
- Keep pooled browser contexts under `BrowserPool` ownership so repeat Tier 2 requests cannot reuse a context closed by a separate cache (#45).

### Changed
- Bump all application and internal package versions to `1.3.1`.

## [1.3.0] - 2026-08-02

### Added
- Detect and resolve Akamai Bot Manager behavioral interstitials across scraper tiers and the HTTP/HTTPS proxy (#33).
- Document supported upstream proxy formats, local Compose configuration, and residential proxy pools (#26).

### Fixed
- Reject non-object request bodies and missing, non-string, or blank `url` values with HTTP 400 before scraper-tier execution (#34).
- Recover stalled browser checkouts and bound browser close/launch operations so wedged Firefox processes cannot silently exhaust the pool (#36, #37, #48).
- Report HTTP 503 from `/health` whenever the browser pool has no live capacity.
- Pass authenticated proxy credentials to Firefox separately from the proxy server URL in Tier 3 and Tier 4 (#40).
- Return complete Tier 1 text responses instead of the 4 KiB challenge-detection preview (#46, #47).
- Record the correct architecture-specific Camoufox release metadata in API images.

### Changed
- Bump all application and internal package versions to `1.3.0`.
- Update workspace dependencies to their latest compatible releases. TypeScript remains on 5.9 for the Nuxt app until `vue-tsc` supports TypeScript 7.

## [1.2.0] - 2026-07-26

### Added
- **Tier 0 direct forward in the MITM proxy** (`apps/api/src/proxy/directForward.ts`): the proxy at `:8192` now forwards requests directly to upstream via raw TCP/TLS instead of spinning up a browser for every request. Pool is reserved for the requests that actually need CF bypass; Netflix/YouTube/banks/etc. flow at near-direct speed.
- **Smart adaptive streaming** (`apps/api/src/proxy/streaming.ts`): small JSON/HTML/text responses are buffered so the challenge detector can inspect them; video/audio/binary files (`.mp4`, `.mkv`, `.m3u8`, `.zip`, `.exe`, `.dmg`, etc.) are streamed straight through to the client. Default threshold: 8 MiB.
- **Per-hostname challenge cache** (`apps/api/src/proxy/challengeCache.ts`): the proxy remembers which hostnames recently returned Cloudflare challenges and sends repeat visits directly to the tiered solver for 5 minutes.
- **Persistent browser context cache**: solved sessions retain their browser fingerprint, cookies, cache, and storage across proxy requests, with bounded per-proxy reuse and cleanup.
- **General HTTP/HTTPS proxy support**: CONNECT tunneling, plain HTTP absolute-form requests, WebSocket upgrades, request bodies, redirects, authentication headers, cookies, and HTTP Range/206 responses are forwarded with their required semantics.
- **`proxySanitizeHeaders()`** (`packages/tiers/src/utils/sanitize.ts`): permissive header sanitizer for the transparent MITM proxy — passes `Authorization`, `Cookie`, `Range`, `User-Agent`, `Referer`, and custom API tokens through, strips only RFC 7230 hop-by-hop headers.
- **Raw bytes in `@trawl/tiers`**: `ScrapeResult` and tier results now expose `body?: Uint8Array`, `responseHeaders?: Record<string,string>`, and `contentType?: string` alongside the existing `html` field. The proxy uses these fields to preserve binary content without HTML normalization.
- **Tier 1 method handling fix**: `runTier1()` now forwards the request body for `PUT`, `PATCH`, `DELETE`, `QUERY` (was only `POST`).
- **Graceful proxy shutdown** (`shutdownMitmProxy()`): the API captures the proxy handle on startup and `lifecycle.ts` calls `shutdownMitmProxy()` on `SIGTERM`/`SIGINT` before the browser pool shutdown, so in-flight connections drain.
- **MITM proxy port + CA volume in docker-compose**: `8192:8192` port mapping, `MITM_PROXY_*` env vars, and a persistent `trawl_proxy_ca` volume so the CA survives container restarts.
- **Proxy tests**: header sanitization, response policy, adaptive streaming, challenge caching, direct HTTP forwarding, Range/206 handling, chunked responses, compressed challenge detection, and explicit media streaming.
- **Proxy documentation**: architecture, configuration, client setup, and CA installation guides for operating systems, browsers, Java/JDownloader, containers, and application-specific trust stores.

### Changed
- `packages/types/src/index.ts` — `ScrapeResult` extended additively with optional `body`, `responseHeaders`, and `contentType`; native `/scrape` consumers should tolerate these additional fields.
- `apps/api/src/proxy/server.ts` — `fetchRaw`/`reissue` replaced by `proxyRequest()` (Tier 0 with `scrape()` fallback) for both CONNECT-based HTTPS and plain HTTP traffic.
- `lifecycle.ts` — `registerLifecycleHandlers()` accepts an optional `{ onShutdown }` callback.
- `apps/api/src/index.ts` — captures the proxy handle on startup and wires it into `registerLifecycleHandlers`.
- All application and internal package versions bumped to `1.2.0`.

## [1.1.0] - 2026-07-22

### Added
- **Browser-backed MITM forward-proxy mode** (`MITM_PROXY_ENABLED`, off by default): HTTP(S) forward proxy that re-issues requests through the browser pool so clients like Prowlarr, Jackett, JDownloader, and changedetection.io can hit fingerprint-bound Cloudflare sites that the `/v1` cookie handoff cannot. The generated root CA is persisted, per-host certificates are minted in memory, and the root is downloadable at `GET /proxy-ca.crt`. New env: `MITM_PROXY_{ENABLED,PORT,HOST,CA_DIR,MAX_TIER,DEBUG}`.

### Changed
- `fetchRaw` rotates `proxyPool` on Cloudflare challenge (same `markBad → next()` pattern as Tier 3) instead of retrying on the same IP.
- Main MITM proxy listener supports a configurable bind address through `MITM_PROXY_HOST`.
- `ci.yml` runs on PRs targeting `dev` in addition to `main`.
- `publish.yml` inspects the actually-pushed tag from `docker/metadata-action` instead of re-deriving from `github.sha` (which previously mismatched the 7-char short SHA).
- `node-forge ^1.3.1` runtime dep for CA + per-host leaf cert generation.

## [1.0.1] - 2026-07-18

### Changed
- `packages/browser/src/pool.ts` — renamed Firefox prefs key from `prefs` (silently ignored by camoufox-js@0.11.1) to `firefox_user_prefs` (which camoufox-js maps to Playwright's `firefoxUserPrefs`). The prefs are now actually applied.
- `packages/browser/src/pool.ts` — added the safe-only subset of Firefox prefs: telemetry off (`datareporting.*`, `toolkit.telemetry.*`, `app.crashreporter`, `breakpad.*`), dead UI features off (`extensions.screenshots.*`, `browser.sessionstore.max_tabs_undo`), dead network services off (`browser.safebrowsing.*`, `extensions.update.*`, `browser.fixup.alternate.*`, `app.normandy.*`, `app.shield.*`, `network.connectivity-service.*`, `network.captive-portal-service.*`, `network.prefetch-next`, `beacon.enabled`), `security.OCSP.enabled: 0`, and tightened network timeouts (`tls-handshake-timeout: 30`, `connection-timeout: 60`, `response.timeout: 120`). None of these touch the JS/CSS fingerprint surface.
- `apps/api/Dockerfile` — stage-3 prune of apt cache + `/usr/share/{locale,doc,man}` (image-size win, runtime-neutral).
- `apps/api/Dockerfile` — added 9 Bun runtime ENV flags (`BUN_DISABLE_CJS=1`, `BUN_DEBUG=0`, `BUN_DISABLE_SOURCEMAPS=1`, `BUN_HTTP_KEEPALIVE=0`, `BUN_AGENT_DISABLE=1`, `BUN_INSPECT=0`, `BUN_LOCKFILE_MIGRATION=false`, `MIMALLOC_PURGE_DELAY=0`, `NODE_NO_WARNINGS=1`). All verified runtime-neutral in smoke tests.
- `packages/browser/package.json` — moved `patchright` + `playwright-core` from `dependencies` to `devDependencies` (build hygiene; camoufox-js bundles both transitively at runtime).
- All packages bumped to `1.0.1`.

### Added
- `scripts/bench-targets.sh`, `scripts/bench-success-rate.sh`, `scripts/bench-compare.sh` — observability harnesses for measuring CF challenge latency + bypass success rate.
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
