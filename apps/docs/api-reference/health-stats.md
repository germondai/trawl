---
title: Health & Stats
description: GET /, GET /health and GET /stats — status and monitoring endpoints.
---

# Health & Stats

These endpoints require no authentication and are safe to expose to monitoring tools.

---

## `GET /`

FlareSolverr-style readiness message — confirms the API process is up (does not wait on the browser pool).

### Response

```json
{
  "msg": "TRAWL is ready!",
  "version": "1.6.4",
  "uptime": 42
}
```

### Curl

```bash
curl -s http://localhost:8191/
```

---

## `GET /health`

Full system health check. Used by Docker Compose health checks and monitoring systems.

### Response

```json
{
  "status": "ok",
  "uptime": 3842,
  "pool": {
    "total": 1,
    "busy": 1,
    "available": 0,
    "restarts": 0,
    "avgRestarts": 0,
    "stalled": 0,
    "live": 1
  },
  "memory": {
    "currentBytes": 734003200,
    "limitBytes": 1073741824,
    "recommendedLimitBytes": 1073741824,
    "underProvisioned": false,
    "oomEvents": 0,
    "oomKills": 0
  }
}
```

| Field              | Type   | Description                              |
| ------------------ | ------ | ---------------------------------------- |
| `status`           | string | `"ok"` when the pool has live capacity; otherwise `"starting"` |
| `uptime`           | number | Seconds since the API process started    |
| `pool.total`       | number | Total browser instances in the pool      |
| `pool.busy`        | number | Browsers currently processing a request  |
| `pool.available`   | number | Browsers ready to accept a request       |
| `pool.restarts`    | number | Total browser restarts since worker boot |
| `pool.avgRestarts` | number | Average restarts per browser             |
| `pool.stalled`     | number | Checked-out browsers past their deadline |
| `pool.live`        | number | Connected, non-stalled browser capacity  |
| `memory.currentBytes` | number | Current cgroup memory usage |
| `memory.limitBytes` | number | Cgroup memory limit |
| `memory.recommendedLimitBytes` | number | Recommended minimum for the configured browser pools |
| `memory.underProvisioned` | boolean | Whether the detected limit is below the recommendation |
| `memory.oomEvents` | number | OOM events reported by the cgroup |
| `memory.oomKills` | number | OOM kills reported by the cgroup |

`/health` returns HTTP 503 while the pool is warming up or has no live browser capacity. A saturated but healthy pool remains ready because active, connected requests still count as live.
The optional `memory` object is included when Linux cgroup memory data is available; its presence does not affect readiness.

### Curl

```bash
curl -s http://localhost:8191/health | jq
```

---

## `GET /stats`

Lightweight public stats for dashboards and landing pages.

### Response

```json
{
  "browsers": 5,
  "available": 4,
  "busy": 1,
  "restarts": 0,
  "stalled": 0,
  "live": 5
}
```

| Field       | Type   | Description                          |
| ----------- | ------ | ------------------------------------ |
| `browsers`  | number | Total browser pool size              |
| `available` | number | Idle browsers                        |
| `busy`      | number | Browsers in use                      |
| `restarts`  | number | Total browser restarts since startup |
| `stalled`   | number | Checked-out browsers past their deadline |
| `live`      | number | Connected, non-stalled browser capacity |

### Curl

```bash
curl -s http://localhost:8191/stats | jq
```

### Prometheus / uptime monitoring

Point an uptime monitor (e.g. UptimeRobot, Uptime Kuma) at `/health`. A 200 response with `"status": "ok"` confirms full operation.

For Prometheus, scrape `/stats` and parse the JSON — or add a `/metrics` endpoint as a future extension.
