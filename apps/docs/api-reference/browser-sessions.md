---
title: Browser Sessions
description: Reuse an isolated browser context across native API, MCP and FlareSolverr requests.
---

# Browser sessions

A named session preserves cookies, localStorage, sessionStorage and browser identity between requests. Use it for login flows or a sequence of requests that must share state. Each session has its own context; it does not read or write the shared domain clearance cache.

## Native API

Create a session with `POST /sessions`. Send `{}` for a generated UUID or provide an ID:

```sh
curl -X POST http://localhost:8191/sessions \
  -H 'Content-Type: application/json' \
  -d '{"id":"account"}'
```

The response is HTTP 201 with `{ "id": "account", "createdAt": 1770000000000, "expiresAt": 1770003600000, "busy": false }`. Timestamps are Unix milliseconds. IDs accept 1-128 ASCII letters, digits, underscores or hyphens.

Creation options:

| Field | Default | Description |
| --- | --- | --- |
| `id` | UUID | Unique session ID; duplicates return 409 |
| `proxy` | Configured proxy pool, otherwise direct | HTTP, HTTPS or SOCKS5 URL; fixed for the life of the session |
| `headful` | `false` | Use the headful pool; requires `BROWSER_HEADFUL_POOL_SIZE > 0` |
| `ignoreCertificateErrors` | `false` | Context TLS policy; certificate verification remains enabled by default |

Use `sessionId` with ordinary `/scrape` options, including POST bodies, screenshots and diagnostics:

```sh
curl -X POST http://localhost:8191/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/login","sessionId":"account","method":"POST","headers":{"Content-Type":"application/x-www-form-urlencoded"},"body":"username=example&password=example"}'

curl -X POST http://localhost:8191/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/account","sessionId":"account"}'

curl http://localhost:8191/sessions
curl -X DELETE http://localhost:8191/sessions/account
```

`GET /sessions` returns `{ "sessions": [...] }` with ID, timestamps and busy state only. It does not expose cookies or proxy credentials. `DELETE /sessions/:id` closes the context and returns `{ "status": "ok" }`.

## FlareSolverr compatibility

These `/v1` commands use the same sessions as the native API:

```json
{ "cmd": "sessions.create", "session": "account" }
{ "cmd": "sessions.list" }
{ "cmd": "request.get", "url": "https://example.com/account", "session": "account" }
{ "cmd": "sessions.destroy", "session": "account" }
```

`sessions.create` accepts an optional `session` ID and `proxy` (URL string or FlareSolverr proxy object). Lifecycle commands do not require a URL. Their responses carry the usual `status`, `message`, timestamps and `version`, plus `session` for creation or an array of ID strings in `sessions` for listing.

Repeated `sessions.create` calls with the same ID reuse the existing session. Native creation still rejects duplicate IDs. A `/v1` scrape with an unknown or idle-expired `session` creates one automatically, subject to the same capacity limit. Such implicit creation ignores the request proxy, matching FlareSolverr; set a fixed proxy through `sessions.create`.

`session_ttl_minutes` optionally replaces a session when its age exceeds this value. Zero disables age-based rotation. Rotation retains the fixed proxy, headful mode and TLS policy. The deployment idle TTL still applies independently.

`request.post` accepts `session` and `postData`. Without a content-type header it defaults to `application/x-www-form-urlencoded`; explicit headers retain their existing behavior. A per-request proxy is ignored when `session` is provided.

`cookies` accepts an array with `name`, `value`, optional `domain`, `path`, `expires` (or Selenium's `expiry`), `httpOnly`, `secure` and `sameSite`. A non-empty import replaces browser cookies before navigation. Domain and path default to the target hostname and `/`. Import is also available on native `/scrape`, forces a fresh/session browser context, and never publishes login cookies to the shared clearance cache. Input is limited to 200 cookies and 1,000,000 name/value characters.

`returnOnlyCookies: true` omits `solution.response`. `returnScreenshot: true` returns a base64 screenshot in `solution.screenshot`. Both request a browser rather than an HTTP-only result. This compatibility covers session lifecycle and these scrape options; it does not emulate every FlareSolverr-specific browser setting or its exact error messages/status codes.

## MCP

Create the session through the native API, then pass its `sessionId` to `scrape`, `read`, `extract`, `screenshot` or `inspect`. Existing public URL restrictions still apply. MCP does not expose login credentials or a POST login tool; perform authentication through `/scrape` first.

## Limits and lifecycle

- `BROWSER_SESSION_MAX_ENTRIES=4` caps contexts per TRAWL instance. A full registry returns 429 rather than evicting another user's session. For a small container, start with one session and measure your target workload.
- `BROWSER_SESSION_TTL_SECONDS=3600` expires idle sessions. Each completed request renews the idle TTL; an active request is bounded by its own `maxTimeout`. Creation waits at most 30 seconds for browser capacity.
- Requests in one session must be sequential. Concurrent use or deletion while busy returns 409. Different sessions share the configured browser pool and its existing acquisition timeout.
- Named requests always use their browser context, report Tier 3 (Tier 4 when required by `SCRAPE_MIN_TIER=4`) and require `maxTier >= 3`. They do not fall back to a different proxy, browser identity or context, or replay a POST on another tier. A Tier 4 deployment requires a session proxy and selects the residential proxy pool by default.
- Proxy, headful mode and TLS policy are fixed at creation. Native requests cannot override proxy or TLS policy. Opting out of TLS verification retains the crossed-landing guard.
- Request pages, including popups, close after each operation. Cookies and localStorage remain in the context. sessionStorage is snapshotted by origin and restored before page scripts on the next request. Snapshots are limited to 32 origins and 5,000,000 key/value characters per session; exceeding a bound or failing to capture storage retires the session. The restore script is removed after initial navigation so subsequent challenge reloads can update or clear storage normally. Open tabs and in-memory page JavaScript do not persist.
- A live session postpones idle retirement and count-based recycling of its browser, without holding a pool lease while idle. The container memory guard and crash recovery remain active. If the browser is replaced, the context closes and the session becomes unavailable (404 or 410); create a new session and authenticate again.
- A request deadline invalidates its context before capacity is reused, because a timed out operation may still be changing storage. A failed page request without a deadline does not discard the session automatically.
- Sessions live in the current process, are not saved in Redis and do not survive a TRAWL restart. Use the same instance for creation and subsequent requests. These endpoints use the same trusted-network access model as `/scrape` and `/v1`; a session ID grants access to its stored login state.
