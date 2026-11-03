---
title: Low-resource Setup
description: An optional configuration for low-traffic instances, with cold boot, idle retirement, clearance reuse and bounded sessions.
---

# Low-resource Setup

For occasional *arr searches or infrequent API calls, keep the API available and launch Firefox
only when a request needs it. This reduces unused browser memory and processes between requests.
The first browser-backed request after startup or retirement includes the cost of launching Firefox.

This is an opt-in configuration recipe. TRAWL's defaults still warm the browser at startup and
keep it running. Use an image with `BROWSER_COLD_BOOT` support; setting an environment variable
does not add the feature to an older image.

## Base configuration

Add these values to your `.env` file alongside your existing configuration:

```dotenv
WAF_DETECTION_ENABLED=false
BROWSER_COLD_BOOT=true
BROWSER_IDLE_TIMEOUT_MS=1800000
BROWSER_POOL_SIZE=1
BROWSER_MAX_CONTENT_PROCESSES=2
TIER1_TRANSPORT=bun
```

The last three values already match the defaults. They keep the profile small without lowering
Firefox's process preference below the tested default or changing its CPU fingerprint.

| Setting | Effect | Tradeoff |
| --- | --- | --- |
| `WAF_DETECTION_ENABLED=false` | Disables the offline provider-identification worker | Provider diagnostics, logs and WAF counters are omitted; challenge solving is unchanged |
| `BROWSER_COLD_BOOT=true` | Registers sleeping capacity without launching Firefox at startup | The first browser-backed request waits for startup |
| `BROWSER_IDLE_TIMEOUT_MS=1800000` | Retires an unused browser after 30 minutes | The next browser request starts it again; its in-memory cache is lost |
| `BROWSER_POOL_SIZE=1` | Keeps one browser slot | Browser-backed requests queue while that slot is busy; HTTP requests can still run concurrently |
| `BROWSER_MAX_CONTENT_PROCESSES=2` | Keeps the default Firefox content-process preference | This is not a hard limit on all Firefox processes or threads |
| `TIER1_TRANSPORT=bun` | Uses Bun HTTP fetch without the optional native transport's workers | Keep `wreq` instead if your targets need its HTTP fingerprint |

Choose the idle interval to match your traffic:

| Idle interval | Value in milliseconds | Suitable for |
| --- | ---: | --- |
| 15 minutes | `900000` | Infrequent work, with more frequent cold starts |
| 30 minutes | `1800000` | A starting point for occasional searches |
| 60 minutes | `3600000` | Irregular bursts where keeping a browser warm is useful |

Recreate the service to apply environment changes:

```bash
docker compose up -d trawl
```

Use `-f docker-compose.prod.yml` if that is your existing deployment. The supplied Compose files
pass cold boot and idle retirement from `.env`; a custom Compose file must explicitly pass them
under `services.trawl.environment`.

## Keep clearance reuse enabled

Keep the session cache available. Accepted clearance cookies can let repeat requests use HTTP
without waking Firefox, even after idle retirement. Requests still fetch fresh target content.
The provider can expire or reject clearance, which causes normal browser fallback.

`SCRAPE_MIN_TIER=1` permits this HTTP path and is the default. Preserve a higher tier floor when
your deployment requires it for proxy routing. Avoid forcing `skipHttp: true` unless the request
needs a browser, such as a screenshot or a retained page.

See [automatic clearance reuse](/getting-started/performance#get-fast-repeat-requests) for eligibility
and [page content or widget tokens](/getting-started/performance#page-content-or-widget-tokens)
when a request only needs page content.

### A single instance without Redis

For a new single-instance deployment, the minimal Compose file can keep clearance in memory
without running a Redis container. Set these additional values in `.env`, including when you
copied `.env.example`, which selects Redis:

```dotenv
SESSION_CACHE_DRIVER=memory
MEMORY_SESSION_CACHE_MAX_ENTRIES=100
```

Then use the minimal file:

```bash
docker compose -f docker-compose.minimal.yml up -d
```

The cache is lost on restart and is not shared across replicas. The optional limit of 100 entries
suits a small set of target domains; its default is 1000. It caps retained entries rather than
preallocating memory. Evicted clearance may need another browser solve, so increase it if your
workload visits many domains.

Keep Redis when you need shared or persistent clearance. Switching the cache driver in the
regular stack does not stop its Redis container. When migrating to the minimal stack, check for
the previous Redis container and stop it only if it is no longer needed.

## Sessions and other resource controls

Named browser sessions retain contexts and prevent their browser from retiring until the
sessions are closed or expire. Destroy sessions with `DELETE /sessions/:id` when finished.
This is separate from the shared clearance cache, which can survive idle retirement.

For a client that needs only one short-lived named session at a time, an optional configuration is:

```dotenv
BROWSER_SESSION_MAX_ENTRIES=1
BROWSER_SESSION_TTL_SECONDS=900
```

The defaults are four sessions and a one-hour idle TTL. Lower capacity rejects additional
sessions with HTTP 429; a shorter TTL expires inactive sessions and their retained browser state.
Choose these values for the client's workflow, especially when it retains a login or an eval page.

Other settings worth reviewing:

| Setting | Recommendation |
| --- | --- |
| `BROWSER_HEADFUL_POOL_SIZE` | Keep the default `0` unless you need DataDome Device Check or headful sessions. Set `1` for those workflows; it adds another browser and Xvfb. Cold boot also applies to this pool. |
| `BROWSER_BLOCK_ADS` | Keep the default `true` initially. Disabling uBlock removes extension overhead, but allows ads and trackers to load and may increase total work. Measure your targets before changing it. |
| `BROWSER_HARDWARE_CONCURRENCY` | Leave unset initially. A lower reported CPU count can reduce PoW workers but increase solve time or total CPU work. |
| `BROWSER_RECYCLE_AFTER_CONTEXTS` | Keep the default `8`. Existing recycling and memory-pressure recovery help control browser growth; very frequent recycling adds launch work. |
| `BROWSER_ACQUIRE_TIMEOUT_MS` | Keep enough time for a cold launch and any queue. The default is 15 seconds; increasing it allows more waiting, not more browser capacity. The request's overall deadline still applies. |

Enable screenshots, diagnostics, response-body capture and archives only when the request needs
them. Keep required CAPTCHA verification and content waits for workflows that depend on them.
See [Configuration](/getting-started/configuration) for individual settings and defaults.

## Check the result

Before the first browser-backed request, inspect health:

```bash
curl -s http://localhost:8191/health | jq '{status, pool, memory}'
```

With one unused cold slot, expect `status: "ok"`, `pool.live: 0` and `pool.sleeping: 1`.
Health checks and ordinary HTTP requests do not launch Firefox. A browser-backed request wakes
the pool; after it becomes idle for the chosen interval, it can return to sleeping capacity.
Active work, queued requests, cleanup and retained sessions prevent retirement.

Readiness can temporarily return HTTP 503 during wake-up when no other healthy capacity exists.
A failed initial launch is not counted as healthy sleeping capacity; existing recovery retries
remain bounded. Use `/stats` to inspect the optional headful pool separately.

Compare the same targets before and after changing a setting: verify the returned content,
separate first and repeat requests, and observe working memory, CPU and queue time. With no
browser running, the API still uses memory; total container memory can also include reclaimable
file cache. This recipe does not establish a universal RAM budget or prevent every OOM.

Keep the supplied `shm_size: 1gb`: it is shared-memory capacity, allocated as used, rather than a
1 GiB reservation or a container RAM limit. Active pages and CAPTCHA work still need memory
headroom. The recorded [benchmark profile](/getting-started/performance#measured-configuration)
is a separate, workload-specific configuration measured with a warm browser.
