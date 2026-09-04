---
title: Session Cache
description: How TRAWL caches solved browser sessions to avoid unnecessary challenge work, with a pluggable Redis or in-memory driver.
---

# Session Cache

The session cache is what makes Tier 2 possible. After a successful Tier 3 or Tier 4 solve, TRAWL
saves the extracted cookies and browser user agent in the configured cache backend. The next request
to the same hostname injects that state into a browser context and attempts to reuse the solved
session.

## Cache driver

TRAWL supports two session cache drivers, selected at startup via `SESSION_CACHE_DRIVER`:

| Driver | Value | Shared across instances | External dependencies |
| --- | --- | --- | --- |
| Redis (default) | `redis` | Yes | Redis 8.8 |
| In-memory | `memory` | No (per-process) | None |

```ini
SESSION_CACHE_DRIVER=redis   # default — shared across instances
SESSION_CACHE_DRIVER=memory  # in-process Map, zero dependencies
```

Use `redis` when running multiple API instances behind a load balancer — sessions solved on one
instance are visible to all others. Use `memory` for single-instance deployments where the
operational overhead of Redis is not justified; sessions are scoped to the process and lost on
restart.

Both drivers implement the `ISessionCache` interface, so additional backends (e.g. SQLite, Valkey,
KeyDB) can be added without touching the orchestrator or tier logic.

## Storage format

Key: `session:{hostname}` (e.g. `session:nowsecure.nl`)

Value (JSON):
```typescript
interface SessionData {
  cookies: Cookie[]
  userAgent: string
  savedAt: number    // unix timestamp ms
}
```

TTL: `REDIS_SESSION_TTL_SECONDS` (default 3600 seconds / 1 hour).

## Session key

The key is the **hostname only** — no path, no port, no protocol. This means all pages on a domain share one session:

```
https://example.com/        → session:example.com
https://example.com/page    → session:example.com  (same key)
https://sub.example.com/    → session:sub.example.com  (different key)
```

Subdomains have separate sessions because WAF and application cookies can differ per subdomain.

## Lifecycle

```
Tier 3 succeeds
  │
  ├── extract cookies from browser context
  ├── REDIS SET session:hostname → JSON  EX REDIS_SESSION_TTL_SECONDS
  │
  └── next request to same domain:
        REDIS GET session:hostname
          ├── hit  → Tier 2: inject cookies and navigate
          └── miss → Tier 3: fresh solve, save to cache
```

## Invalidation

If Tier 2 navigates with cached state and still receives a recognized challenge wall, the orchestrator:

1. Calls `sessionCache.invalidate(domain)` — deletes the Redis key
2. Escalates to Tier 3 to get a fresh session

This handles provider cookies expiring or being rejected before the Redis TTL ends.

## Redis

When `SESSION_CACHE_DRIVER=redis` (the default), TRAWL talks to Redis 8.8 with `new RedisClient(REDIS_URL)` from Bun's native Redis client (not ioredis).

The cache is optional. When `REDIS_URL` is empty or unset, TRAWL does not create a Redis client and
Tier 2 remains disabled.

Each connection attempt is bounded by `REDIS_CONNECT_TIMEOUT_MS` (default 5 seconds). If Redis is
not ready, scraping continues without Tier 2 while TRAWL retries in the background every
`REDIS_RETRY_DELAY_MS` (default 5 seconds). Set the retry delay to `0` to disable reconnects after a
configured Redis endpoint becomes unavailable.

```typescript
import { RedisClient } from 'bun'

const redis = new RedisClient('redis://localhost:6379')
await redis.set('session:example.com', JSON.stringify(data), 'EX', 3600)
const raw = await redis.get('session:example.com')
```

## In-memory

When `SESSION_CACHE_DRIVER=memory`, TRAWL uses an in-process `Map` with TTL-based expiry. There is
no `connect()` step and no network I/O — the cache is available immediately on startup. Entries
are lazily expired on read and can be proactively pruned via `MemorySessionCache.prune()`.

Because the cache lives in the API process, sessions are **not shared** across instances. A solve
on instance A is invisible to instance B. Use this driver only for single-instance deployments.
