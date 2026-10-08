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

| Method | Path      | Description                   |
| ------ | --------- | ----------------------------- |
| `GET`  | `/health` | Pool status and uptime        |
| `GET`  | `/stats`  | Public numbers for dashboards |
| `POST` | `/v1`     | FlareSolverr v2 compatible    |
| `POST` | `/scrape` | Native TRAWL API              |
| `POST` | `/sessions` | Create an isolated browser session |
| `GET` | `/sessions` | List live browser sessions |
| `DELETE` | `/sessions/:id` | Close a browser session |

## Forward proxy

When `MITM_ENABLED=true`, TRAWL also listens as an HTTP/HTTPS forward proxy on
`MITM_PORT` (default `8192`). This is a socket-level proxy interface rather than a JSON API
endpoint. It forwards normal traffic directly and escalates recognized challenge walls through the
same tier engine as `/scrape`.

HTTPS clients must trust the generated TRAWL CA. Start with the
[proxy overview](/proxy/overview), then follow [client setup](/proxy/client-setup) and
[CA installation](/proxy/ca-installation).

## Error responses

Most error responses follow this shape:

```json
{ "error": "Human-readable message" }
```

Pool-exhaustion errors are an exception — they return a FlareSolverr v2 envelope so `/v1` and `/scrape` produce identical bodies on saturation. See [FlareSolverr compat → Error response](/api-reference/flaresolvr-compat#error-response) for the envelope shape.

HTTP status codes:

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 201 | Browser session created |
| 404 | Session missing or expired |
| 409 | Duplicate ID or session busy |
| 410 | Session browser lost during acquisition |
| 200  | Success                                                              |
| 400  | Bad request (missing/invalid fields)                                 |
| 429  | Pool exhausted — all browsers busy past `BROWSER_ACQUIRE_TIMEOUT_MS` |
| 503  | Browser pool initializing                                            |
| 500  | Internal error                                                       |

::: info CORS
The API does **not** emit `Access-Control-Allow-Origin` headers. TRAWL is designed for direct, same-network access (e.g. Prowlarr/Jackett, internal services, your reverse proxy). If you need browser-based cross-origin access, terminate at a proxy that adds the CORS headers you need.
:::
