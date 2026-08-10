---
title: Architecture Overview
description: How TRAWL's API, forward proxy, browser pool, session cache, and tiered challenge engine fit together.
---

# Architecture Overview

```
Client (Prowlarr, curl, browser, your code)
           │
      ┌────┴───────────────┐
      ▼                    ▼
 Elysia API          HTTP/HTTPS proxy :8192
 POST /v1            Tier 0 direct forwarding
 POST /scrape        + challenge detection
 GET /health                │ detected wall
      └──────────────┬──────┘
                     ▼
      Orchestrator (packages/tiers)
    ┌──────────────────────────────────────┐
    │    ├── Tier 1: plain Bun fetch       │
    │    ├── Tier 2: cached session + pool │
    │    ├── Tier 3: fresh solve + pool    │
    │    └── Tier 4: residential proxy     │
    └──────────────┬───────────────────────┘
          ┌────────┴──────────┐
          ▼                   ▼
   BrowserPool          SessionCache
   (packages/browser)   (packages/browser)
          │                   │
          ▼                   ▼
     Camoufox            Redis (cache)
     Firefox N×
```

## Components

### API (`apps/api`)

An Elysia HTTP server. Accepts scrape requests and calls the orchestrator inline — all browser work happens in the same process. Exposes `/` for a FlareSolverr-style readiness message, plus `/health` and `/stats` for monitoring. Routes live under `apps/api/src/routes/`, with shared config/pool state in `config.ts`/`deps.ts`.

### Forward Proxy (`apps/api/src/proxy`)

An optional general HTTP/HTTPS proxy on port `8192`. Ordinary requests use direct TCP/TLS forwarding, preserving methods, bodies, authentication headers, redirects, WebSocket upgrades, binary content, and HTTP Range semantics. Small textual responses are buffered for challenge detection; media and large files can stream directly. When a response is identified as a challenge wall, the proxy sends the request through the same four-tier orchestrator used by `/scrape`.

HTTPS inspection requires clients to trust TRAWL's generated root CA. See [Proxy overview](/proxy/overview) and [CA installation](/proxy/ca-installation).

### Browser Pool (`packages/browser/src/pool.ts`)

Maintains a fixed set of `{ browser, context }` pairs using [Camoufox](https://github.com/daijro/camoufox) (Firefox with fingerprint patching at the C++/Juggler level). Acquisition is sticky — if a browser last served `example.com`, it is preferred for the next request to `example.com`. Browsers accumulate domain cookies across requests, which makes subsequent challenges faster.

### Session Cache (`packages/browser/src/session.ts`)

Stores `{ cookies, userAgent, savedAt }` in Redis, keyed by hostname (`session:example.com`). The TTL is configurable (default 1 hour). Tier 3 writes to it on every successful challenge solve. Tier 2 reads from it at the start of every request.

Redis is optional — if `REDIS_URL` is not set, the session cache is disabled and every request escalates to Tier 3.

### Tiers (`packages/tiers`)

The escalation logic and challenge-specific browser waits. Cloudflare, AWS WAF, Akamai Bot Manager, and Imperva/Incapsula walls are detected separately so Tier 3 and Tier 4 can run the appropriate resolution flow. Embedded AWS WAF CAPTCHA, Turnstile, reCAPTCHA v2, hCaptcha, and GeeTest slide widgets are attempted after the protected page loads. See [Tiered Execution](/architecture/tiered-execution) for the full breakdown.
