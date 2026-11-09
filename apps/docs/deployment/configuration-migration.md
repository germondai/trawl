---
title: Configuration Migration
description: Upgrade notes and environment-variable changes across TRAWL releases.
---

# Configuration migration

## Upgrading from v1.10.1 to v1.11.0

No configuration or data migration is required. Recreate the container with the updated
image and retain existing data volumes.

Supported NCBI and Anubis GET challenges can now complete in the HTTP tier without
opening a browser. Native hashing is bounded by the request deadline and a one-second
cap; unsupported or rejected attempts retain browser fallback. See
[HTTP proof-of-work handling](/architecture/tiered-execution#tier-1-plain-http-fetch)
for supported algorithms and cookie limits.

POST requests keep their existing behavior by default. Set `httpReplay: true` to opt
into HTTP reuse of browser-verified Cloudflare or Anubis clearance. Accepted or ambiguous
submissions are not resent during browser recovery. See
[automatic HTTP clearance reuse](/architecture/session-cache#automatic-http-clearance-reuse).

Prowlarr proxy pings can succeed without cookies when
`FLARESOLVERR_COOKIE_FALLBACK=true`; protected indexers still require usable cookie handoff.

The client workspace remains at 0.1.0; this release does not publish it to npm.

## Upgrading from v1.10.0 to v1.10.1

No configuration changes are required. Recreate the container with the updated image
for the non-root browser startup fix; keep existing Redis data and dashboard volumes.
The image also validates its bundled GeoIP database during the build and preserves
declared HTML charsets in the HTTP tier.

Prowlarr users who encounter `Empty cookies returned by FlareSolverr` can opt in to
`FLARESOLVERR_COOKIE_FALLBACK=true`. It permits one browser tier after a successful
stateless GET without usable cookies, within the original request deadline. The
option is off by default; POST and native scraping retain their existing behavior.
See [Cookie Handoff](/getting-started/configuration#flaresolverr-cookie-handoff).

The client workspace remains at 0.1.0; this release does not publish it to npm.

## Upgrading from v1.9.3 to v1.10.0

MCP now validates and pins public destination IPs when opening HTTP and browser
connections. If you pass a named session to MCP, recreate it through
`POST /sessions` with `publicOnly: true`; this restriction cannot be added to an
existing context. Background requests and retained-page eval keep the same
public-only policy, including when that session is used through the native API.
See [MCP sessions](/api-reference/browser-sessions#mcp).

MCP uses a separate clearance cache, so its first requests may need to solve a
challenge again. Keep existing Redis data: native clearance reuse is unchanged.
Ordinary native API, `/v1` and MITM requests retain private-network access for
trusted operators. These endpoints still require a private network or an
authenticated gateway; the dashboard token does not authenticate the scraping API.

For MCP or `publicOnly` sessions behind an upstream proxy, use a trusted forwarding
proxy that honors the approved destination IP. HTTP(S) upstreams must allow
literal-IP CONNECT to every target port, including port 80 for plain HTTP URLs.
TRAWL's own intercepting MITM listener cannot be used as their upstream; ordinary
native MITM use is unchanged.

Offline WAF identification is enabled by default. It adds diagnostic metadata,
logs and metrics without changing solver routing. Disable it per request with
`detectWaf: false` or per deployment with `WAF_DETECTION_ENABLED=false`.

Browser startup remains warm by default. `BROWSER_COLD_BOOT=true` is opt-in and
can be combined with idle retirement; see the [low-resource setup](/getting-started/low-resource).
The new native `/read` and `/extract` endpoints need no additional configuration.
The `@trawl/client` workspace remains at 0.1.0 and is not published to npm as part
of this release.

## Upgrading from v1.9.2 to v1.9.3

No configuration changes are required. This patch preserves charset-less UTF-8
HTML fragments across the scraping APIs, MCP and the proxy, and stops pending
Cloudflare clicks after a challenge clears. Bun and Node.js build tooling include
the upstream Brotli security fixes.

## Upgrading from v1.9.1 to v1.9.2

No configuration changes are required. `GET /metrics` now exposes browser pool
metrics for Prometheus alongside `/stats` and the local dashboard.

`allowShortContent` is an opt-in native scrape option for browser documents under
100 characters. Network-error pages and challenge walls are still rejected.

Shutdown remains immediate by default. To let accepted requests finish during a
restart, set `BROWSER_SHUTDOWN_DRAIN_MS` and allow additional time for browser
cleanup in your supervisor's stop timeout. See [shutdown configuration](/getting-started/configuration#browser-shutdown-drain-ms).

## Upgrading from v1.9.0 to v1.9.1

No configuration changes are required. `POST /sessions/:id/scrape` accepts the
same options as `/scrape` with `sessionId`; both use the existing session.

To retain one main page between operations, create a session with `keepPage: true`.
`POST /sessions/:id/eval` then evaluates JavaScript in that page's main context.
`GET /sessions/:id/cookies` reads the cookie jar, including HttpOnly cookies, for
any named session. See [browser sessions](/api-reference/browser-sessions).

Sessions without `keepPage` retain per-request page cleanup. All named sessions
remain process-local and must be recreated after an API restart or invalidation.

## Upgrading from v1.8.0 to v1.9.0

Keep the existing Redis data and dashboard volume mounted. Older clearance-cache
entries without proxy provenance are ignored and refreshed on the next solve.
Named browser sessions still need to be recreated after restarting the API.

`SCRAPE_MAX_TIMEOUT_MS` sets the default scrape deadline; it remains 60 seconds
when unset. An explicit request timeout takes precedence.

FlareSolverr `/v1` requests now prioritize page delivery without solving optional
embedded form widgets. Blocking access challenges still require resolution.
Native and MCP scraping expose `solveEmbeddedCaptchas` for this choice.

The optional external solver can now capture Cloudflare Challenge Page parameters
without a site profile. It remains disabled without a configured provider key.
Real paid-service acceptance has not been verified.

## Upgrading from v1.7.0 to v1.8.0

No environment-variable renames are required for this upgrade. Keep the existing
Redis data and metrics volume mounted: solved clearance sessions remain reusable,
and the dashboard retains its request history. Back up persisted data before upgrading.

Named [browser sessions](/api-reference/browser-sessions) are separate from the
Redis clearance cache. They live in the API process and do not survive a restart.
Clients must recreate and authenticate them after a restart or a 404/410 response.
The memory guard can also invalidate them under pressure; a 1 GiB limit does not
guarantee retention of authenticated sessions.

The [external CAPTCHA solver](/getting-started/configuration#optional-external-captcha-solver)
is disabled by default. Built-in solving does not require a paid API key. Specialized
external tasks require target-specific profiles; real paid-service acceptance has
not been verified.

Browser resource controls are optional. Ad blocking stays enabled, idle retirement
stays disabled, and no CAPTCHA solver or resource profile is enabled automatically.
See [configuration](/getting-started/configuration) before changing these settings.

## Migration from versions before v1.5.0

TRAWL v1.5.0 reorganizes configuration into short, subsystem-specific namespaces. The old
names are not retained as aliases: update `.env`, Compose overrides, container manifests, secrets,
and deployment automation before upgrading.

## Environment variables

| Previous name                      | New name                          |
| ---------------------------------- | --------------------------------- |
| `SESSION_TTL_SECONDS`              | `REDIS_SESSION_TTL_SECONDS`       |
| `BROWSER_CONTENT_PROCESSES`        | `BROWSER_MAX_CONTENT_PROCESSES`   |
| `CAPTURE_MAX_CONSOLE_ENTRIES`      | `DIAGNOSTICS_MAX_CONSOLE_ENTRIES` |
| `CAPTURE_MAX_NETWORK_ENTRIES`      | `DIAGNOSTICS_MAX_NETWORK_ENTRIES` |
| `CAPTURE_SIZES_TIMEOUT_MS`         | `DIAGNOSTICS_SIZE_TIMEOUT_MS`     |
| `CAPTURE_MAX_REDIRECT_ENTRIES`     | `REDIRECT_MAX_ENTRIES`            |
| `CAPTURE_MAX_RESPONSE_PATTERNS`    | `CAPTURE_MAX_PATTERNS`            |
| `CAPTURE_MAX_RESPONSE_BYTES`       | `CAPTURE_MAX_BODY_BYTES`          |
| `CAPTURE_MAX_RESPONSE_TOTAL_BYTES` | `CAPTURE_MAX_TOTAL_BYTES`         |
| `CAPTURE_SETTLE_IDLE_FLOOR_MS`     | `CAPTURE_IDLE_FLOOR_MS`           |
| `MITM_PROXY_ENABLED`               | `MITM_ENABLED`                    |
| `MITM_PROXY_HOST`                  | `MITM_HOST`                       |
| `MITM_PROXY_PORT`                  | `MITM_PORT`                       |
| `MITM_PROXY_CA_DIR`                | `MITM_CA_DIR`                     |
| `MITM_PROXY_MAX_TIER`              | `MITM_MAX_TIER`                   |
| `MITM_PROXY_ALWAYS_SCRAPE`         | `MITM_ALWAYS_SCRAPE`              |
| `MITM_PROXY_DEBUG`                 | `MITM_DEBUG`                      |

Two previous shared limits now have independent settings. Copy the old value to every applicable
new variable if you want to preserve custom limits exactly:

| Previous shared name       | New independent names                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `CAPTURE_MAX_STRING_CHARS` | `DIAGNOSTICS_MAX_STRING_CHARS`, `REDIRECT_MAX_URL_CHARS`, `CAPTURE_MAX_METADATA_CHARS` |
| `CAPTURE_MAX_TOTAL_CHARS`  | `DIAGNOSTICS_MAX_TOTAL_CHARS`, `REDIRECT_MAX_TOTAL_CHARS`                              |

`CHROME_EXECUTABLE` was unused and has been removed. TRAWL uses its packaged Camoufox Firefox
binary; there is no replacement variable.

## Redis opt-in behavior

With the default `SESSION_CACHE_DRIVER=redis`, `REDIS_URL` is the cache switch as well as the
connection address:

```text
empty or unset REDIS_URL  → session cache disabled, no connection attempts
non-empty REDIS_URL       → session cache enabled, background reconnects allowed
```

The standard Compose variants configure their bundled Redis. The minimal variant defaults to the
in-memory driver; select `redis` and provide an external URL to use Redis there.

## Docker build argument

The Camoufox-specific font-retention argument is now namespaced:

```text
KEEP_SPOOFED_OS_FONTS → CAMOUFOX_KEEP_SPOOFED_OS_FONTS
```

For example:

```bash
docker build \
  --build-arg CAMOUFOX_KEEP_SPOOFED_OS_FONTS=1 \
  -f apps/api/Dockerfile \
  -t trawl .
```

Keeping the spoofed macOS and Windows font bundles adds approximately 891 MB to the image. Enable
it only when rendered output must match those spoofed operating-system profiles.

## Compose `.env` behavior

The supplied Compose files explicitly pass every supported runtime setting from the adjacent `.env`
file into the TRAWL container. Unknown host variables are not forwarded. Run this after editing the
file to inspect the effective configuration:

```bash
docker compose config
```

`PORT` is intentionally used only for the host-side `PORT:8191` mapping; the container continues to
listen on `8191`. The Redis-backed Compose variants route `REDIS_URL` to their bundled `redis`
service, while the minimal variant defaults to memory and passes an optional external Redis URL.

Recreate the container after changing environment variables:

```bash
docker compose up -d --force-recreate trawl
```
