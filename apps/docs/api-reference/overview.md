---
title: API Overview
description: Base URL, content types, and response conventions.
---

# API Overview

## Base URL

```
http://localhost:8191
```

Or wherever you've mapped `PORT` (default `8191`).

## Authentication

TRAWL has no authentication — all endpoints are open. Run it on a private network or behind a firewall if you need access control.

## Content type

All request and response bodies are JSON:

```http
Content-Type: application/json
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Pool status and uptime |
| `GET` | `/stats` | Public numbers for dashboards |
| `POST` | `/v1` | FlareSolverr v2 compatible |
| `POST` | `/scrape` | Native TRAWL API |

## Error responses

Most error responses follow this shape:

```json
{ "error": "Human-readable message" }
```

Pool-exhaustion errors are an exception — they return a FlareSolverr v2 envelope so `/v1` and `/scrape` produce identical bodies on saturation. See [FlareSolverr compat → Error response](/api-reference/flaresolvr-compat#error-response) for the envelope shape.

HTTP status codes:

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (missing/invalid fields) |
| 429 | Pool exhausted — all browsers busy past `BROWSER_ACQUIRE_TIMEOUT_MS` |
| 503 | Browser pool initializing |
| 500 | Internal error |

::: info CORS
The API does **not** emit `Access-Control-Allow-Origin` headers. TRAWL is designed for direct, same-network access (e.g. Prowlarr/Jackett, internal services, your reverse proxy). If you need browser-based cross-origin access, terminate at a proxy that adds the CORS headers you need.
:::
