---
name: Bug report
about: Something in TRAWL is broken
title: "[bug] "
labels: bug
assignees: ''
---

## Describe the bug

A clear and concise description of what went wrong.

## Reproduction

```bash
# Minimal command(s) to reproduce. Example:
curl -X POST http://localhost:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://nowsecure.nl","maxTimeout":60000}'
```

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened — paste the API response, error message, or log excerpt here.

## Environment

- **TRAWL version:** (e.g. `0.1.0`, `sha-abc1234`, or `latest`)
- **Deployment:** `docker compose` / `docker compose.prod` / bare metal
- **OS:** (e.g. Ubuntu 24.04, macOS 15)
- **Architecture:** `amd64` / `arm64` / `arm/v7`
- **Browser pool size:** (env `BROWSER_POOL_SIZE`)
- **Redis:** version + reachable from the container? (yes/no)
- **Tier the bug appears in:** Tier 1 / 2 / 3 / 4 (see `README.md`)

## Logs

If available, paste relevant logs from `docker compose logs trawl` (redact any session cookies or tokens before posting).

```text
PASTE LOGS HERE
```

## Additional context

Anything else — rate limits hit, network conditions, similar issues that worked before, etc.
