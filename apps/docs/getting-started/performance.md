---
title: Performance & Benchmarks
description: Measured request performance, automatic HTTP clearance reuse and configuration for fast repeat requests.
---

# Performance & Benchmarks

TRAWL tries HTTP before opening a browser. Once a browser has cleared a supported challenge,
eligible repeat requests can send the saved clearance cookies and User-Agent over HTTP.
If the site still requires a browser, TRAWL falls back through its existing tiers.

For low-traffic instances, see the optional [low-resource setup](/getting-started/low-resource)
for cold boot, idle retirement, cache choices and session limits.

## Recorded results

The current comparison was measured on **2026-10-17**, using the development build after v1.8.0.
The published v1.8.0 image predates automatic HTTP clearance replay.

- [Full results](https://github.com/germondai/trawl/blob/main/benchmarks/RESULTS.md): per-site first
  and repeat times, medians, verification counts, CPU, working memory and total memory.
- [Method and reproduction](https://github.com/germondai/trawl/blob/main/benchmarks/README.md):
  configuration, workload and content checks.

The main comparison uses Cloudflare interstitial page-access workflows on NopeCHA, 1337x and
EZTV with TRAWL, FlareSolverr and Byparr on the same machine and network. Standalone CAPTCHA
widget completion and other challenge families are outside this comparison.

## Get fast repeat requests

Enable either session-cache driver and keep Tier 1 available (`SCRAPE_MIN_TIER=1`, the default).
The cache is shared automatically by hostname; no named session is needed for clearance reuse.

For example, send this request, then repeat it after the first successful response:

```bash
curl -X POST http://localhost:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://nopecha.com/demo/cloudflare","maxTimeout":60000}'
```

The first request may need a browser solve. A repeat can use HTTP if the cached clearance is
valid and accepted for that origin. Each request still fetches fresh content from the target;
TRAWL does not return a cached response body.

In the native API, an accepted HTTP replay reports `tier: 1` and `sessionCached: true`.
A cached browser response reports Tier 2. Replay is limited to direct GET/HEAD requests, or POST
requests that set `httpReplay: true` (clearance cookies only, never resent after a timeout or
disconnect), with verified TLS and eligible Cloudflare or Anubis cookies. Explicit proxies, a configured
datacenter proxy pool, imported cookies and browser captures do not use this replay path.
See [Session Cache](/architecture/session-cache) for cookie scope, expiry and fallback rules.

### Page content or widget tokens

`/v1` defaults to delivering page content after access challenges clear. It does not wait for
optional embedded form tokens unless `solveEmbeddedCaptchas: true` is requested.

Native `/scrape` and MCP `scrape` attempt embedded widgets by default. When only page content
is needed, set `solveEmbeddedCaptchas: false`:

```bash
curl -X POST http://localhost:8191/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://nopecha.com/demo/cloudflare","maxTimeout":60000,"solveEmbeddedCaptchas":false}'
```

Blocking access challenges must still resolve. A page delivered without a widget token is not
a successful form verification. Only verified widget solutions enter `captchasSolved`, and
TRAWL does not submit surrounding forms. See the [native API](/api-reference/native-api#embedded-captcha-widgets)
and [MCP scrape tool](/integrations/mcp).

### When to keep a browser

Use [named browser sessions](/api-reference/browser-sessions) when a workflow needs isolated
login state, localStorage or sessionStorage. These retain a browser context and do not use
the shared clearance cache or HTTP replay. Named-session timings are reported separately.

Screenshots, browser diagnostics and content-selector waits need browser work. For native
requests that require browser output, set `skipHttp: true`; the MCP screenshot and inspect
tools already force browser execution. Reducing browser work must not skip required content
or CAPTCHA verification.

## Measured configuration

The Cloudflare comparison used this TRAWL profile with Redis available on the Compose network:

```ini
SESSION_CACHE_DRIVER=redis
REDIS_URL=redis://redis:6379
SCRAPE_MIN_TIER=1
BROWSER_POOL_SIZE=1
BROWSER_HEADFUL_POOL_SIZE=0
BROWSER_BLOCK_ADS=false
BROWSER_MAX_CONTENT_PROCESSES=1
BROWSER_HARDWARE_CONCURRENCY=4
```

These are tested settings for this workload, not a universal fastest preset. The content-process
preference and reported hardware concurrency are browser hints, not hard process or CPU limits.
Ad blocking may help other workloads. DataDome Device Check may require the opt-in headful pool.
See [Configuration](/getting-started/configuration) before changing an existing deployment.

For a single API instance, `SESSION_CACHE_DRIVER=memory` also supports automatic clearance reuse
without Redis. Its state is lost on restart; the recorded resource totals use Redis and include
its cost. Cache retention never extends the provider's cookie expiry.

## Read the measurements

- **First** means the target's TRAWL cache was cleared before the request, with the browser
  already warm. It is not container startup or a cold browser launch.
- **Repeat** means a later request in that round. The site may accept HTTP or require another
  browser visit; repeated requests are not guaranteed to be faster.
- **Best** is the fastest verified response in the sample. Medians describe the same sample
  separately. A returned status code alone does not establish that page content was delivered.
- **CPU time** measures processor work, not elapsed request time. Matched comparisons use
  request keys verified by every tool; complete workload totals also include failed work.
- **Working memory** excludes inactive file cache; **total memory** includes it. These are
  sampled cgroup measurements, not process RSS. TRAWL's totals include Redis.

The run used native ARM64 images on Apple Silicon with OrbStack, two rounds in reverse tool
order, and one first request plus two repeats per target in each round. Requests specified a
30-second budget; client timings include request overhead and response transfer. Application
startup was outside the measurements. No application memory cap or CPU quota was set, and
shared-memory capacity was 1 GiB. Resource sampling ran separately every 250 ms.

Live-site challenge difficulty, IP reputation, network and host load can change between requests.
The recorded results do not establish a universal success rate or prove that arbitrary pages
cannot exhaust memory. Use the linked report's separate timings and resource columns rather
than combining their best values into a single claimed request.
