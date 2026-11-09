# Contributing to TRAWL

Thanks for your interest in contributing! TRAWL is a self-hosted web scraping engine released under [AGPL-3.0](LICENSE). By submitting a contribution, you agree to license your work under the same terms.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful, assume good faith, and focus on the technical merits.

## Reporting bugs & requesting features

Please use the GitHub issue templates - they ensure we have the context we need:

- **Bug reports:** [`.github/ISSUE_TEMPLATE/bug_report.md`](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests:** [`.github/ISSUE_TEMPLATE/feature_request.md`](.github/ISSUE_TEMPLATE/feature_request.md)

For security issues, **do not open a public issue** - see [SECURITY.md](SECURITY.md).

## Development setup

Requirements depend on the workspace:

- **API and shared packages:** Bun 1.4.4 is the runtime and package manager.
- **Web and docs:** Node.js 26.13.0 runs the Nuxt and VitePress build tools; Bun installs dependencies.
- **Integration tests:** Docker provides Redis and the Linux browser environment.

The scraper service runs on Bun. Its Docker runtime does not require Node.js.

Camoufox stays at 152.0.4-beta.30, the newest browser supported by camoufox-js
0.13.0. The API images backport the eMudhra OneCRL revocations and their startup
import until a compatible upstream browser includes both fixes. Playwright Core
stays at 1.62.1 to satisfy its peer constraint. Bundled uBlock Origin stays at
1.75.0: versions 1.75.2 and 1.75.4 failed proxied browser readiness checks with
this Camoufox build. The web workspace uses TypeScript 6.0.3 because vue-tsc
needs its JavaScript compiler API; the API and shared packages use TypeScript 7.

Docker builds the native PoW solver with Rust 1.99.1 and checks its protocol vectors
and runtime ABI. It builds the offline WAF worker with Go 1.27.3. Rod requires `got/lib/lcs`,
removed in `got` 0.43.0, and the constructor API removed in `fetchup` 0.4.0; keep
`got` at 0.42.4 and `fetchup` at 0.3.0. The module retains Go 1.26 as its minimum
language version.

```bash
git clone https://github.com/germondai/trawl.git
cd trawl
bun install
cp .env.example .env
```

Keep optional dependencies enabled when installing: `TIER1_TRANSPORT=wreq` needs
the platform-specific node-wreq binding. The default Bun transport does not load it.

### Running the apps

```bash
bun run dev:api     # Elysia API on :8191
bun run dev:web     # Nuxt 4 landing page
bun run dev:docs    # VitePress docs site
```

Redis is the default session cache. Start it with `docker compose up -d redis`, or use
`SESSION_CACHE_DRIVER=memory` for a process-local cache.

### Linting & formatting

We use [Biome](https://biomejs.dev/) for both:

```bash
bun run check       # read-only format, lint, and import-order check
bun run fix         # apply safe Biome fixes and formatting
bun run typecheck   # typecheck TypeScript workspaces, including browser/tier tests
bun run build       # production-build the web and docs apps
bun run verify      # full release gate: check, types, tests, and builds
```

CI runs `bun run verify` on every PR.

### Browser integration tests

Meta refresh integration tests use a real Camoufox browser with local HTTP fixtures,
including a simulated cross-host challenge. They are skipped in the default test suite.
Install the compatible browser version pinned in `apps/api/Dockerfile` (currently
152.0.4-beta.30), then run:

```bash
TRAWL_BROWSER_TESTS=1 CAMOUFOX_INSTALL_DIR=/path/to/camoufox bun test packages/browser/tests/metaRefresh.integration.test.ts
```

`CAMOUFOX_INSTALL_DIR` must contain the extracted browser bundle and its `version.json`.
Apply the same security backport used by the images to a fresh extracted bundle:

```bash
python3 packages/browser/security/backport-onecrl.py "$CAMOUFOX_INSTALL_DIR"
bun packages/browser/security/check-onecrl.ts
```

The patch checks the pinned resource hashes and rejects an unexpected or already
patched bundle. Unlike upstream, it schedules the import before the first window
opens, because pooled browsers have no page until a request arrives. The check requires a real Linux browser and verifies the six
eMudhra revocations in a fresh profile with external connections blocked. Both
API Dockerfiles run this check without network access before completing the image.

Cached proxy-session integration tests cover `/scrape` and `/v1`, original proxy/cookie identity,
external solver proxy propagation, context cleanup on deadline and the direct-session fast path.
They use owned HTTP and provider fixtures without paid requests:

```bash
TRAWL_PROXY_SESSION_TESTS=1 CAMOUFOX_INSTALL_DIR=/path/to/camoufox bun test apps/api/src/proxySessions.integration.test.ts
```

Turnstile lifecycle tests use owned widgets to check consumed tokens, removal without
a solution, cancellation, and both API routes in cached and fresh browser sessions:

```bash
TRAWL_TURNSTILE_TESTS=1 CAMOUFOX_INSTALL_DIR=/path/to/camoufox bun test apps/api/src/turnstile.integration.test.ts
```

Cloudflare fallback tests use owned challenge pages and two local HTTP proxies. They cover
both API routes, persistent clearance, a stalled recovery navigation and context cleanup:

```bash
TRAWL_CLOUDFLARE_FALLBACK_TESTS=1 CAMOUFOX_INSTALL_DIR=/path/to/camoufox bun test apps/api/src/cloudflareFallback.integration.test.ts
```

Raw text browser integration tests use owned HTTP fixtures and a local forward proxy:

```bash
TRAWL_RAW_TEXT_TESTS=1 CAMOUFOX_INSTALL_DIR=/path/to/camoufox bun test packages/browser/tests/rawText.integration.test.ts
```

They check TXT, JSON, XML, charset-less HTML fragments, whitespace, empty files and
declared charsets in browser tiers, plus rejection of empty HTML and HTTP blocks.

Firefox preference integration tests cover both headless and virtual-display pools:

```bash
TRAWL_USER_PREFS_TESTS=1 CAMOUFOX_INSTALL_DIR=/path/to/camoufox bun test packages/browser/tests/userPrefs.integration.test.ts
```

They use owned HTTP fixtures and local DNS mapping to check JavaScript preferences
and `.onion` blocking without requiring access to Tor.

Browser pool resource integration tests exercise the actual `/scrape` and `/v1`
HTTP routes, queue deadlines, recycling and crash recovery. Run in a Linux
container with a 1 GiB memory/swap limit and the installed Camoufox runtime:

```bash
TRAWL_POOL_RESOURCE_TESTS=1 BROWSER_BLOCK_ADS=false BROWSER_HARDWARE_CONCURRENCY=4 SESSION_CACHE_DRIVER=memory METRICS_DB_PATH=:memory: bun test apps/api/src/poolResources.integration.test.ts
```

The fixtures simulate a challenge page; they do not establish live CAPTCHA
success rates. Heavy browser workloads may require a larger memory limit.

Release PRs from `dev` to `main` and release publishing include this resource
suite in browser smoke checks. Regular PRs keep the shorter suite. Run the CI
workflow manually with `resource_tests` enabled for the same checks before
preparing a release, or use `TRAWL_POOL_RESOURCE_TESTS=1 bash scripts/browser-smoke.sh trawl-smoke`
with an already built image. The resource suite runs with a 1 GiB memory/swap
limit; session and shutdown suites retain their existing 2 GiB limit.

External CAPTCHA integration tests use owned widgets, a local provider API fixture
and real Camoufox. They never submit a paid task:

```bash
TRAWL_EXTERNAL_CAPTCHA_TESTS=1 BROWSER_BLOCK_ADS=false BROWSER_HARDWARE_CONCURRENCY=4 SESSION_CACHE_DRIVER=memory METRICS_DB_PATH=:memory: bun test apps/api/src/externalCaptcha.integration.test.ts apps/api/src/externalCaptchaProfiles.integration.test.ts
```

These tests cover native and Prowlarr routes, reCAPTCHA without an anchor iframe,
page callbacks, custom Turnstile response fields, callback-only widgets, task
limits, CSP failure, structured answers, screenshot tasks, grid/coordinate clicks
and site-scoped cookie delivery. The target fixture independently checks answers.
They do not establish live 2Captcha success rates.

### Docker browser smoke tests

CI builds the standard runtime and exercises owned HTTP fixtures with a 1 GiB
container limit, or 2 GiB for persistent session tests so the memory guard does
not evict their contexts. These tests cover delayed JavaScript content, readiness
with ongoing traffic, raw text, redirects, and native/FlareSolverr sessions. They
do not contact CAPTCHA providers or establish live bypass success rates.

```bash
docker build -f apps/api/Dockerfile -t trawl-smoke .
bash scripts/browser-smoke.sh trawl-smoke
```

Pages that load their desired content asynchronously should set
`contentWaitForSelector`; response capture has its own settle window. With an
explicit content selector, ongoing analytics or streaming requests do not need
to finish before returning content. Without one, browser tiers retain their
default settling behavior within the request deadline.

## Project layout

This is a Bun monorepo with workspaces:

```
apps/
  api/      Elysia API (the scraper service)
  web/      Nuxt 4 landing page
  docs/     VitePress documentation
packages/
  browser/  Camoufox Firefox pool
  tiers/    Tier 1-4 execution engine
  types/    Shared TypeScript types
  client/   Portable npm client for the native HTTP API
```

Apps are independently deployable; `packages/*` are imported via the workspace protocol (e.g. `workspace:*`).

The client has its own release version. `packages/types/src/api.ts` holds public HTTP
contracts; the existing types entry point also exports internal server types. Client
builds bundle the public declarations, so published consumers do not need a private
workspace package. Run `bun --cwd packages/client build` and
`bun --cwd packages/client lint:package` before preparing an npm tarball. Client changes
do not require changing the scraper service version. npm publication requires a separate
maintainer-approved release.

`bun scripts/check-client-package.ts` installs the built tarball outside the monorepo
and checks its declarations, Node/Bun/Deno imports, CommonJS exports and browser bundle.
It requires Node.js, Bun and Deno on `PATH`; CI runs it after the normal verification gate.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Recent examples:

```
ci(publish): build images for linux/amd64, linux/arm64, linux/arm/v7
chore: add .gitignore files for api, docs, web, and browser packages
fix(browser): restore pool after worker crash
```

The `type` is one of `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`, `perf`. Keep the subject under 72 chars and in the imperative mood.

## Pull request process

1. **Open an issue first** for non-trivial changes. A two-paragraph problem statement is enough.
2. **Branch from `main`.** Use a descriptive name (`feat/captcha-hcaptcha`, `fix/redis-reconnect`).
3. **Run `bun run verify` before pushing.** Lint, types, tests, and production builds must be clean.
4. **Update `CHANGELOG.md`** under `## [Unreleased]` for any user-visible change.
5. **Fill out the PR template** - the checklist catches the easy-to-miss items.
6. **Keep PRs focused.** One feature or fix per PR; large refactors should be split.

## Adding a new tier or solver

TRAWL's design centers on a 4-tier escalation ladder (HTTP → cached session → fresh CF solve → residential proxy). If your contribution introduces a new tier or a new solver:

- Put tier logic in `packages/tiers/`.
- Put browser/solver adapters in `packages/browser/`.
- Update the tier diagram in `README.md`.
- Add an entry to `CHANGELOG.md`.

## License

TRAWL is licensed under **AGPL-3.0**. By submitting a pull request, you affirm that your contribution is your own work and you agree to license it under AGPL-3.0. AGPL is more restrictive than MIT/Apache - if your employer might claim ownership of your work, get explicit approval first.
