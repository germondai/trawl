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
  cmd: 'request.get' | 'request.post'
  url: string
  maxTimeout?: number   // milliseconds, default 60000
  postData?: string     // body for request.post
  headers?: Record<string, string>
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | string | Yes | `"request.get"` or `"request.post"` |
| `url` | string | Yes | The URL to scrape |
| `maxTimeout` | number | No | Max wait in ms (default 60000) |
| `postData` | string | No | POST body (only for `request.post`) |
| `headers` | object | No | Extra headers to send (merged with browser defaults) |

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

```json
{
  "status": "error",
  "message": "timeout",
  "startTimestamp": 1700000000000,
  "endTimestamp": 1700000060000,
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
