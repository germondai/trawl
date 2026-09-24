---
title: Browser Pool
description: How the persistent Firefox pool works — warm instances, sticky routing, and self-healing.
---

# Browser Pool

The browser pool is the core performance differentiator over FlareSolverr and Byparr. Instead of launching a new browser process per request (3–5 seconds each), TRAWL keeps N instances always running and ready to accept work.

## Design

```typescript
interface PoolEntry {
  id: number
  browser: Browser         // Camoufox browser instance
  context: BrowserContext  // single persistent context per browser
  busy: boolean
  lastDomain?: string      // hostname of the last request served
  lastUsedAt?: number      // unix timestamp
  restartCount: number
  healthy: boolean
  temporaryContextUses: number
  restartReason?: string
}
```

Each entry is a `{ browser, context }` pair. `Camoufox({...})` creates the browser; `browser.newContext()` creates an in-memory cookie context. Cookies accumulate across page navigations within one context, which helps CF managed-mode challenges resolve faster. Pages are closed on release to free memory.

## Acquisition

`pool.acquire(domain)` uses sticky routing:

1. Look for an idle browser whose `lastDomain === domain` — reuse it (its context may already have warm CF cookies)
2. Fall back to any idle browser
3. If all browsers are busy, poll every `pollIntervalMs` (default **100ms**) for up to `acquireTimeoutMs` (default **15000ms** = 15s)
4. Throw `PoolExhaustedError` after `acquireTimeoutMs` with no idle browser

The domain match is on the **hostname only** — `https://example.com/page1` and `https://example.com/page2` both match `example.com`.

Both thresholds are configurable via the `BrowserPool` constructor:

```typescript
new BrowserPool({
  poolSize: 1,                // BROWSER_POOL_SIZE (default 1)
  acquireTimeoutMs: 15000,    // BROWSER_ACQUIRE_TIMEOUT_MS — 15s default
  pollIntervalMs: 100,        // how often to re-check for an idle browser
  recycleAfterTemporaryContexts: 8,
  contentProcesses: 2,        // BROWSER_MAX_CONTENT_PROCESSES — caps Firefox content procs
  stallAfterMs: 180000,       // BROWSER_STALL_TIMEOUT_MS
  closeTimeoutMs: 10000,      // BROWSER_CLOSE_TIMEOUT_MS
  launchTimeoutMs: 90000,     // BROWSER_LAUNCH_TIMEOUT_MS
})
```

When `acquireTimeoutMs` elapses, the API surfaces the rejection as **HTTP 429** with a FlareSolverr v2 error envelope — both on `/v1` (Prowlarr/Jackett) and on `/scrape` (native). See the [API reference](/api-reference/overview#error-responses).

## Release

`pool.release(id)` marks the browser idle and closes all open pages. `lastDomain` is updated to the domain just served. Cookies are kept to speed up the next request to the same domain.

Tier 3 and Tier 4 create short-lived isolated contexts for fresh challenge solves and proxy escalation. Those contexts are closed by the tier code, but long-running Firefox/Camoufox processes can still retain child content processes after repeated solves. Two complementary defenses bound this growth:

1. **`contentProcesses` (default `2`)** caps Firefox content processes per browser at launch via the `dom.ipc.processCount` Firefox pref. This is the primary defense — bounds thread/RAM growth at the source regardless of context churn.
2. **`recycleAfterTemporaryContexts` (default `8`)** counts every Tier 3/Tier 4 context creation, including successful, timed-out, errored, and blocked attempts. At the threshold the pool warms a replacement while the current browser remains available, swaps it in when idle, and then closes the retired browser. Only one replacement is warmed across the pool at a time, so the brief memory peak is bounded to one additional browser. Set `BROWSER_RECYCLE_AFTER_CONTEXTS=0` to disable this recycling.

See issues #13, #17, and #52, plus the [configuration docs](/getting-started/configuration#browser_recycle_after_contexts) for tuning.

## Self-healing

A health check runs every 30 seconds. Disconnected idle browsers are relaunched in place, and checkouts that exceed the request budget plus `BROWSER_STALL_TIMEOUT_MS` are reclaimed. Lease tokens prevent a late release from an abandoned request from freeing a replacement checkout.

Browser/context close and browser launch operations are bounded by `BROWSER_CLOSE_TIMEOUT_MS` and `BROWSER_LAUNCH_TIMEOUT_MS`. This keeps a wedged Firefox process from leaving a pool entry permanently stuck in restart. `/health` reports 503 when no connected, non-stalled capacity remains.

## Why Camoufox Firefox, not Chromium?

Cloudflare detects datacenter Chromium via multiple signals: the CDP leak (`Runtime.enable` fires in a detectable pattern), `navigator.webdriver`, missing browser internals, and fingerprint inconsistencies.

Camoufox patches Firefox at the C++/Juggler level — fingerprint data (fonts, canvas, WebGL, screen resolution, locale) is spoofed before any JavaScript runs. CF's detection scripts see a real Firefox profile. This is harder to counter than JS-level patches because the data originates from native code, not overridden JS properties.

The published Docker images omit Camoufox's large Windows and macOS font bundles, so their pools
automatically select Linux profiles only. A custom image built with
`CAMOUFOX_KEEP_SPOOFED_OS_FONTS=1` retains those bundles and enables the complete
Windows/macOS/Linux pool; this keeps the claimed OS and measurable fonts consistent in either
configuration.

```typescript
import { Camoufox } from 'camoufox-js'

const browser = await Camoufox({
  headless: true,
  geoip: true,
  humanize: true,
})
```

## Memory usage

Each Camoufox instance uses ~350–500 MB. The default pool of 1 is intended for ordinary scraper and Prowlarr workloads:

| Pool size | RAM usage (browser only) |
| --------- | ------------------------ |
| 1         | ~400 MB                  |
| 3         | ~1.2 GB                  |
| 5         | ~2 GB                    |
| 8         | ~3.2 GB                  |

The API service sets `shm_size: 1gb` in Docker Compose. Firefox uses `/dev/shm` heavily; without enough shared memory, tabs crash silently.
