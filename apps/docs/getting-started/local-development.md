---
title: Local Development
description: Run the TRAWL monorepo locally with Bun, without Docker.
---

# Local Development

TRAWL is a Bun workspace monorepo. You can run each service locally with hot-reload.

## Prerequisites

| Tool  | Version | Install                                     |
| ----- | ------- | ------------------------------------------- |
| Bun   | ≥ 1.2   | `curl -fsSL https://bun.sh/install \| bash` |
| Redis | 8.8+    | Docker (see below)                          |

## 1. Install dependencies

```bash
# From the monorepo root
bun install
```

This installs all workspace packages in one pass.

## 2. Fetch the Camoufox browser

The API uses [Camoufox](https://github.com/daijro/camoufox) — Firefox with fingerprint patching. Fetch the binary once:

```bash
bun x camoufox-js fetch
```

This downloads the browser into the local cache. It only needs to run once per machine.

## 3. Start Redis

```bash
docker run -d --name trawl-redis -p 6379:6379 redis:8.8-alpine
```

Or use any Redis-protocol-compatible server you already have.

## 4. Create your `.env`

```bash
cp .env.example .env
# Defaults work for local development
```

## 5. Start each service

**Terminal 1 — API (browser pool + HTTP server):**

```bash
bun run dev:api
# [pool] browser 1/3 ready
# [pool] browser 2/3 ready
# [pool] browser 3/3 ready
# [api] TRAWL ready on :8191
```

**Terminal 2 — web (optional):**

```bash
bun run dev:web
# Nuxt ready at http://localhost:3000
```

**Terminal 3 — docs (optional):**

```bash
bun run dev:docs
# VitePress ready at http://localhost:3001
```

## 6. Verify

```bash
curl http://localhost:8191/health
```

## Monorepo structure

```
trawl/
├── apps/
│   ├── api/         Elysia HTTP server + embedded browser pool
│   ├── web/         Nuxt 4 landing page
│   └── docs/        VitePress documentation
├── packages/
│   ├── types/       Shared TypeScript interfaces — no runtime logic
│   ├── browser/     BrowserPool + SessionCache
│   └── tiers/       Tier 1–4 executors + orchestrator
├── docker-compose.yml          scraper + Redis (default)
├── docker-compose.minimal.yml  scraper only, no Redis
├── docker-compose.prod.yml     production with restart + healthcheck
└── docker-compose.full.yml     full stack including web + docs
```

## Cross-package TypeScript

Each package has its own `tsconfig.json` that resolves imports from source — no build step needed:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "paths": { "@trawl/types": ["../types/src/index.ts"] }
  }
}
```

`import type { ScrapeRequest } from '@trawl/types'` resolves live in your editor.

## Useful commands

```bash
# Lint + format
bun run check

# Type-check a specific package
bun tsc --noEmit --project packages/browser/tsconfig.json
bun tsc --noEmit --project apps/api/tsconfig.json

# Add a dependency to a specific workspace
bun add some-package --cwd apps/api

# Update lockfile
bun update
```
