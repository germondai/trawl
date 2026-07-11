---
title: Session Cache
description: How TRAWL caches Cloudflare cookies in Redis to make repeat requests fast.
---

# Session Cache

The session cache is what makes Tier 2 possible. After every successful Tier 3 solve, the extracted Cloudflare cookies are saved to Redis. The next request to the same domain injects those cookies into a browser context, skipping the challenge entirely.

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
  ├── REDIS SET session:hostname → JSON  EX SESSION_TTL_SECONDS
  │
  └── next request to same domain:
        REDIS GET session:hostname
          ├── hit  → Tier 2: inject cookies, navigate (500ms)
          └── miss → Tier 3: fresh solve, save to cache
```

## Invalidation

If Tier 2 navigates with the cached cookies and the result is still a Cloudflare interstitial (the session expired before Redis's TTL), the orchestrator:

1. Calls `sessionCache.invalidate(domain)` — deletes the Redis key
2. Escalates to Tier 3 to get a fresh session

This handles the case where Cloudflare's `cf_clearance` cookie (30-minute expiry) expires before the Redis TTL does.

## Redis

TRAWL's cache backend is Redis 8.8. TRAWL talks to it with `new RedisClient(REDIS_URL)` from Bun's native Redis client (not ioredis).

```typescript
import { RedisClient } from 'bun'

const redis = new RedisClient('redis://localhost:6379')
await redis.set('session:example.com', JSON.stringify(data), 'EX', 3600)
const raw = await redis.get('session:example.com')
```
