---
title: Architecture Overview
description: How TRAWL's components fit together — embedded browser pool, session cache, and tiered execution.
---

# Architecture Overview

```
Client (Prowlarr, curl, your code)
           │
           ▼
      Elysia API (apps/api)
    ┌──────────────────────────┐
    │  POST /v1   POST /scrape │
    │  GET /health  GET /stats │
    └────────────┬─────────────┘
                 │ direct call
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

### Browser Pool (`packages/browser/src/pool.ts`)

Maintains a fixed set of `{ browser, context }` pairs using [Camoufox](https://github.com/daijro/camoufox) (Firefox with fingerprint patching at the C++/Juggler level). Acquisition is sticky — if a browser last served `example.com`, it is preferred for the next request to `example.com`. Browsers accumulate domain cookies across requests, which makes subsequent challenges faster.

### Session Cache (`packages/browser/src/session.ts`)

Stores `{ cookies, userAgent, savedAt }` in Redis, keyed by hostname (`session:example.com`). The TTL is configurable (default 1 hour). Tier 3 writes to it on every successful challenge solve. Tier 2 reads from it at the start of every request.

Redis is optional — if `REDIS_URL` is not set, the session cache is disabled and every request escalates to Tier 3.

### Tiers (`packages/tiers`)

The escalation logic. See [Tiered Execution](/architecture/tiered-execution) for the full breakdown.
