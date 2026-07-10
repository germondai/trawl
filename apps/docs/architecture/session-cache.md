---
title: Session Cache
description: How TRAWL caches Cloudflare cookies in Dragonfly to make repeat requests fast.
---

# Session Cache

The session cache is what makes Tier 2 possible. After every successful Tier 3 solve, the extracted Cloudflare cookies are saved to Dragonfly. The next request to the same domain injects those cookies into a browser context, skipping the challenge entirely.

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

TTL: `SESSION_TTL_SECONDS` (default 3600 seconds / 1 hour).

## Session key

The key is the **hostname only** — no path, no port, no protocol. This means all pages on a domain share one session:

```
https://example.com/        → session:example.com
https://example.com/page    → session:example.com  (same key)
https://sub.example.com/    → session:sub.example.com  (different key)
```

Subdomains have separate sessions because Cloudflare can issue different challenge cookies per subdomain.

## Lifecycle

```
Tier 3 succeeds
  │
  ├── extract cookies from browser context
  ├── DRAGONFLY SET session:hostname → JSON  EX SESSION_TTL_SECONDS
  │
  └── next request to same domain:
        DRAGONFLY GET session:hostname
          ├── hit  → Tier 2: inject cookies, navigate (500ms)
          └── miss → Tier 3: fresh solve, save to cache
```

## Invalidation

If Tier 2 navigates with the cached cookies and the result is still a Cloudflare interstitial (the session expired before Dragonfly's TTL), the orchestrator:

1. Calls `sessionCache.invalidate(domain)` — deletes the Dragonfly key
2. Escalates to Tier 3 to get a fresh session

This handles the case where Cloudflare's `cf_clearance` cookie (30-minute expiry) expires before the Dragonfly TTL does.

## Dragonfly

TRAWL's default cache backend is [Dragonfly](https://www.dragonflydb.io/) — a multi-threaded, shared-nothing in-memory datastore that's wire-compatible with the Redis protocol, so no query/command changes were needed to adopt it. It's a drop-in replacement for Redis at the connection-string level (`REDIS_URL` still points at it) while scaling across CPU cores instead of Redis's single-threaded event loop.

TRAWL talks to it with `new RedisClient(REDIS_URL)` from Bun's native Redis client (not ioredis) — Bun's client speaks the same RESP protocol Dragonfly serves, so this needed no code changes either.

```typescript
import { RedisClient } from 'bun'

const redis = new RedisClient('redis://localhost:6379')
await redis.set('session:example.com', JSON.stringify(data), 'EX', 3600)
const raw = await redis.get('session:example.com')
```
