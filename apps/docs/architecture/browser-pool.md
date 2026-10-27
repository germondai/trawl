---
title: Browser Pool
description: How the persistent Firefox pool works - warm instances, sticky routing, and self-healing.
---

# Browser Pool

TRAWL keeps a configurable number of warm browsers to avoid launching a process for every
browser-backed request. Eligible HTTP requests do not acquire a browser. Optional idle retirement
can release unused browsers between bursts of work.

## Design

```typescript
interface PoolEntry {
  id: number
  browser?: Browser        // absent while sleeping
  context?: BrowserContext // shared context for cached browser requests
  busy: boolean
  lastDomain?: string      // hostname of the last request served
  lastUsedAt?: number      // unix timestamp
  restartCount: number
  healthy: boolean
  temporaryContextUses: number
  restartReason?: string
  sleeping?: boolean
}
```

Each live entry contains a browser and shared context for cached browser requests. Fresh
Tier 3/4 solves use temporary isolated contexts; named sessions retain their own isolated
contexts and storage. Request pages are closed during cleanup. Saved clearance cookies can
also be reused over HTTP without a browser; see [Session Cache](/architecture/session-cache).

## Acquisition

`pool.acquire(domain)` uses sticky routing:

1. Prefer an idle browser whose `lastDomain === domain`.
2. Fall back to any idle browser
3. If capacity is busy, queue until release or recovery wakes the request. Sleeping browsers are
   relaunched on demand. A browser handles one checkout at a time.
4. Throw `PoolExhaustedError` when the acquire timeout or remaining request budget expires.

The domain match is on the **hostname only** - `https://example.com/page1` and `https://example.com/page2` both match `example.com`.

The pool is configurable via the `BrowserPool` constructor:

```typescript
new BrowserPool({
  poolSize: 1,                // BROWSER_POOL_SIZE (default 1)
  acquireTimeoutMs: 15000,    // BROWSER_ACQUIRE_TIMEOUT_MS - 15s default
  recycleAfterTemporaryContexts: 8,
  contentProcesses: 2,        // BROWSER_MAX_CONTENT_PROCESSES - Firefox preference
  idleTimeoutMs: 0,           // BROWSER_IDLE_TIMEOUT_MS - disabled by default
  coldBoot: false,            // BROWSER_COLD_BOOT - launch on first request instead of startup
  stallAfterMs: 180000,       // BROWSER_STALL_TIMEOUT_MS
  closeTimeoutMs: 10000,      // BROWSER_CLOSE_TIMEOUT_MS
  drainTimeoutMs: 0,          // BROWSER_SHUTDOWN_DRAIN_MS - close at once by default
  launchTimeoutMs: 90000,     // BROWSER_LAUNCH_TIMEOUT_MS
})
```

When `acquireTimeoutMs` elapses, the API surfaces the rejection as **HTTP 429** with a FlareSolverr v2 error envelope - both on `/v1` (Prowlarr/Jackett) and on `/scrape` (native). See the [API reference](/api-reference/overview#error-responses).

## Release

`pool.release(id, lease)` completes page cleanup before making capacity available again. The
lease token prevents a late release from freeing a replacement checkout. `lastDomain` records
the served hostname; shared-context cookies can remain available for later cached requests.

Tier 3 and Tier 4 create short-lived isolated contexts for fresh challenge solves and proxy escalation. Those contexts are closed by the tier code, but long-running Firefox/Camoufox processes can still retain child content processes after repeated solves. Two complementary defenses bound this growth:

1. **`contentProcesses` (default `2`)** sets Firefox process-count preferences. These reduce
   browser overhead but are not a hard operating-system process or RAM limit.
2. **`recycleAfterTemporaryContexts` (default `8`)** counts every Tier 3/4 temporary context,
   including failed attempts. With sufficient memory headroom, the pool warms one replacement
   before swapping browsers. Small memory limits or low headroom use close-before-launch recovery.
   `BROWSER_RECYCLE_AFTER_CONTEXTS=0` disables count-based recycling; memory-pressure recovery remains.

See issues #13, #17, and #52, plus the [configuration docs](/getting-started/configuration#browser-recycle-after-contexts) for tuning.

## Self-healing

A health check runs every 30 seconds. Disconnected idle browsers are relaunched in place, and checkouts that exceed the request budget plus `BROWSER_STALL_TIMEOUT_MS` are reclaimed. Lease tokens prevent a late release from an abandoned request from freeing a replacement checkout.

Browser/context close and browser launch operations are bounded by `BROWSER_CLOSE_TIMEOUT_MS`
and `BROWSER_LAUNCH_TIMEOUT_MS`. `/health` reports unavailable capacity when no usable browser
or intentionally sleeping capacity remains.

`BROWSER_IDLE_TIMEOUT_MS` defaults to `0`. When enabled, idle browsers close after the configured
interval and relaunch on the next browser-backed request. Shared clearance cache entries survive;
HTTP requests can still use them. Active requests, queued acquires and retained named-session
contexts prevent retirement. See [idle retirement](/getting-started/configuration#browser-idle-timeout-ms).

`BROWSER_COLD_BOOT=true` skips startup launches entirely. Sleeping capacity is registered during
startup and the first browser-backed request wakes it through the same path as idle retirement, so
`/health` stays ready and startup does not reserve browser memory. See
[cold boot](/getting-started/configuration#browser-cold-boot).

## Shutdown

`pool.shutdown()` refuses new checkouts at once. With `drainTimeoutMs` set, it then waits up to
that long for checkouts that can still finish, meaning those that are not stalled and whose
browser is connected. After that it closes every context and browser, each close bounded by
`BROWSER_CLOSE_TIMEOUT_MS`. See [`BROWSER_SHUTDOWN_DRAIN_MS`](/getting-started/configuration#browser-shutdown-drain-ms).

The API first gives accepted HTTP requests one bounded drain window, keeping their
sessions and browsers alive. With a drain configured, Playwright's automatic
`SIGTERM`/`SIGINT` browser closes are disabled so they cannot interrupt that window.
Pool cleanup then skips a second drain. This also allows HTTP-only requests and
queued browser requests to finish. The default `0` still closes immediately.

## Why Camoufox Firefox, not Chromium?

Cloudflare detects datacenter Chromium via multiple signals: the CDP leak (`Runtime.enable` fires in a detectable pattern), `navigator.webdriver`, missing browser internals, and fingerprint inconsistencies.

Camoufox patches Firefox at the C++/Juggler level - fingerprint data (fonts, canvas, WebGL, screen resolution, locale) is spoofed before any JavaScript runs. CF's detection scripts see a real Firefox profile. This is harder to counter than JS-level patches because the data originates from native code, not overridden JS properties.

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

Each Camoufox instance uses ~350-500 MB. The default pool of 1 is intended for ordinary scraper and Prowlarr workloads:

| Pool size | RAM usage (browser only) |
| --------- | ------------------------ |
| 1         | ~400 MB                  |
| 3         | ~1.2 GB                  |
| 5         | ~2 GB                    |
| 8         | ~3.2 GB                  |

The API service sets `shm_size: 1gb` in Docker Compose. Firefox uses `/dev/shm` heavily; without enough shared memory, tabs crash silently.
