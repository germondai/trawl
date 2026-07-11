---
title: FlareSolverr Compat
description: POST /v1 — the drop-in FlareSolverr v2 endpoint.
---

# `POST /v1` — FlareSolverr Compatible

This endpoint implements the FlareSolverr v2 API contract. Any client that works with FlareSolverr works with TRAWL without code changes.

**No authentication required.**

## Request

```typescript
interface FlareSolverrRequest {
  cmd?: 'request.get' | 'request.post'  // default: 'request.get'
  url: string
  maxTimeout?: number   // milliseconds, default 60000
  postData?: string     // body for request.post
  headers?: Record<string, string>
  proxy?: string         // TRAWL extension — not part of the real FlareSolverr contract
}
```

### Fields

| Field        | Type   | Required | Description                                                                                                                                                                                                                         |
| ------------ | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd`        | string | No       | `"request.get"` or `"request.post"` (default `"request.get"`)                                                                                                                                                                       |
| `url`        | string | Yes      | The URL to scrape                                                                                                                                                                                                                   |
| `maxTimeout` | number | No       | Max wait in ms (default 60000)                                                                                                                                                                                                      |
| `postData`   | string | No       | POST body (only for `request.post`). On TRAWL's native `/scrape` endpoint this field is named `body`; the `/v1` adapter maps `postData` → `body` internally so the FlareSolverr wire contract stays unchanged for existing callers. |
| `headers`    | object | No       | Custom headers forwarded to the target across all tiers — see [Custom Headers](/api-reference/custom-headers)                                                                                                                       |
| `proxy`      | string | No       | **TRAWL-specific extension** (not in the real FlareSolverr v2 contract) — per-request proxy override for Tier 3/4, see [Configuration § Proxies](/getting-started/configuration#proxies)                                            |

## Response

```typescript
interface FlareSolverrResponse {
  status: 'ok' | 'error'
  message: string
  startTimestamp: number       // unix ms
  endTimestamp: number         // unix ms
  version: '2.0.0'
  solution: {
    url: string                // final URL after redirects
    status: number             // HTTP status code
    headers: Record<string, string>
    response: string           // raw HTML body
    cookies: Cookie[]
    userAgent: string
  }
}

interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}
```

## Examples

### GET request (curl)

```bash
curl -s -X POST http://localhost:8191/v1 \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": "request.get",
    "url": "https://nowsecure.nl",
    "maxTimeout": 60000
  }'
```

### GET request (JavaScript)

```javascript
const res = await fetch('http://localhost:8191/v1', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cmd: 'request.get',
    url: 'https://nowsecure.nl',
    maxTimeout: 60000,
  }),
})

const data = await res.json()
// data.status === 'ok'
// data.solution.response  → HTML string
// data.solution.cookies   → Cookie[]
// data.solution.userAgent → browser UA
```

### GET request (Python)

```python
import requests

res = requests.post('http://localhost:8191/v1', json={
    'cmd': 'request.get',
    'url': 'https://nowsecure.nl',
    'maxTimeout': 60000,
}, timeout=65)

data = res.json()
assert data['status'] == 'ok'

html    = data['solution']['response']
cookies = data['solution']['cookies']
```

### POST request

```bash
curl -s -X POST http://localhost:8191/v1 \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": "request.post",
    "url": "https://example.com/api/login",
    "postData": "username=user&password=pass",
    "maxTimeout": 30000
  }'
```

## Error response

When the request fails, the response is still a FlareSolverr v2 envelope with `status: "error"` and an empty `solution`. The HTTP status code carries the failure class:

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 200  | `status: "ok"` (request succeeded)                                   |
| 400  | Malformed request body                                               |
| 429  | Pool exhausted — all browsers busy past `BROWSER_ACQUIRE_TIMEOUT_MS` |
| 500  | Internal error                                                       |

Example — pool exhausted (HTTP 429):

```json
{
  "status": "error",
  "message": "Browser pool saturated, retry shortly",
  "startTimestamp": 1700000000000,
  "endTimestamp": 1700000015000,
  "version": "2.0.0",
  "solution": {
    "url": "https://nowsecure.nl",
    "status": 0,
    "headers": {},
    "response": "",
    "cookies": [],
    "userAgent": ""
  }
}
```
