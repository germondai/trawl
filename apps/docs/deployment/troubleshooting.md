---
title: Troubleshooting
description: Common issues and how to fix them.
---

# Troubleshooting

## API never becomes ready

**Symptom:** `docker compose logs trawl` shows browser launches but the API never prints `ready — all N browsers warm`.

**Causes:**

1. **Camoufox binary not installed** — The API image normally installs it during publication.
   The supplied Compose files use a prebuilt image and have no `build` section, so
   `docker compose build` intentionally does nothing. Pull and recreate the service instead:
   `docker compose pull trawl && docker compose up -d --force-recreate trawl`.
2. **shm_size too small** — Ensure `shm_size: 1gb` is set on the API service.

Redis is optional at runtime. If it is unavailable, TRAWL temporarily disables the Tier 2
session-cache fast path but can still become ready and scrape through the other tiers. Unless
`REDIS_RETRY_DELAY_MS=0`, it keeps reconnecting in the background.

## Logs report `Tier 2 disabled`

**Symptom:** TRAWL starts, but its logs contain `session cache unavailable — Tier 2 disabled` even
though `docker compose exec redis redis-cli ping` returns `PONG`.

The Redis-container check only proves that Redis is healthy now. Verify the configured URL, Docker
DNS, and a fresh Redis connection from inside the already-running TRAWL container:

```bash
docker compose exec trawl sh -lc 'printf "%s\n" "$REDIS_URL"; getent hosts redis'
docker compose exec trawl bun -e 'import { RedisClient } from "bun"; const client = new RedisClient(process.env.REDIS_URL); await client.connect(); console.log(await client.ping()); client.close()'
```

With the supplied Redis-backed Compose files, TRAWL waits for the Redis healthcheck before
starting. A slow host may still exceed the client-side connection timeout; TRAWL now retries in the
background and logs `session cache connected` when Tier 2 becomes available, without a process
restart. Increase `REDIS_CONNECT_TIMEOUT_MS` if every attempt times out, or adjust
`REDIS_RETRY_DELAY_MS` to change the retry interval.

If the command fails, inspect `docker compose config` for an overridden `REDIS_URL`, custom
`network_mode`, or networks that are not shared by the `trawl` and `redis` services. Inside Docker,
use `redis://redis:6379`, not `redis://localhost:6379`.

### Startup timeout behind Gluetun

**Symptom:** TRAWL logs `browser launch exceeded ...` during startup and never becomes healthy.

Camoufox performs outbound work, including GeoIP lookup, while launching. If TRAWL starts before
Gluetun has established its VPN connection, that work can hit the browser **launch timeout**. Set
`depends_on.gluetun.condition: service_healthy` as shown in
[Docker Compose → Route TRAWL through Gluetun](/deployment/docker-compose#route-trawl-through-gluetun).

This differs from the **acquire timeout** (`BROWSER_ACQUIRE_TIMEOUT_MS`): a launch timeout means a
browser could not start, often because outbound networking or a GeoIP endpoint was unavailable; an
acquire timeout means the browsers started but all pool capacity remained busy, and `/v1` returns
HTTP 429.

### Requests through the VPN return HTTP 403

If TRAWL starts successfully but a target returns HTTP 403, the VPN is already routing traffic and
the target is likely rejecting the VPN exit IP. Waiting longer for startup will not fix that. Try a
different Gluetun server or exit region, or configure an appropriate application proxy.

Gluetun and `PROXY_URL` operate at different layers: `network_mode: service:gluetun` routes all
container traffic through the VPN, while the optional `PROXY_URL` is used explicitly by TRAWL's
proxy escalation tier. Setting `PROXY_URL` is not necessary for Gluetun routing, and setting it
means that proxied requests still reach that proxy through Gluetun's network namespace.

## Container crash-loops with `EISDIR` or `Cannot find module` errors

**Symptom:** The container restarts continuously, logging one of:

```
error: EISDIR reading "/app/packages/browser/node_modules/camoufox-js"
```

```
error: Cannot find module '@sinclair/typebox' from '/app/apps/api/node_modules/elysia/dist/index.mjs'
```

or, on older images, `error: Cannot find package 'memoirist' from '/app/apps/api/node_modules/elysia/dist/index.mjs'`.

**Cause:** A bug in Bun's default "isolated" install linker corrupted `node_modules` during the Docker build, leaving transitive dependencies (`camoufox-js`, `@sinclair/typebox`) missing or broken inside the image ([oven-sh/bun#23524](https://github.com/oven-sh/bun/issues/23524), [oven-sh/bun#29489](https://github.com/oven-sh/bun/issues/29489)).

::: tip Already fixed — just re-pull
This was fixed by switching the image build to `bun install --linker=hoisted`. Every `:latest` and `:baseline` image published after the fix is unaffected. If you're hitting this, re-pull rather than patching your container:

```bash
docker pull ghcr.io/germondai/trawl:latest   # or :baseline
docker compose up -d --force-recreate
```
:::

## All requests return Tier 3 (never hitting cache)

**Symptom:** every request takes 10–30s, even for the same domain.

**Causes:**

1. **Redis session data is not persisting** — Run `docker compose exec redis redis-cli keys "session:*"` after a successful scrape. If empty, the session cache write is failing. Check API logs for Redis connection errors.
2. **`REDIS_SESSION_TTL_SECONDS` set too low** — If it's shorter than Cloudflare's challenge interval, the cache expires before the next request.
3. **Domain key mismatch** — The key is the hostname only. `sub.example.com` and `www.example.com` are separate sessions.

## POST /v1 returns HTTP 429 with `status: "error"`

**Symptom:** Request returns **HTTP 429** (not 500) with a FlareSolverr v2 envelope and `message: "Browser pool saturated, retry shortly"`.

**Cause:** TRAWL polled for `BROWSER_ACQUIRE_TIMEOUT_MS` (default 15s) without finding an idle browser. The default pool contains one browser to keep ordinary Prowlarr and scraper deployments memory-efficient.

**Fixes (in order of preference):**

1. **Raise `BROWSER_ACQUIRE_TIMEOUT_MS`** if your upstream target legitimately takes >5s per scrape — bumps the queue wait before 429 fires.
2. **Raise `BROWSER_POOL_SIZE`** if you're consistently saturating — each browser uses ~350–500 MB RAM.
3. **Reduce incoming request rate** if you control the client (Prowlarr's indexer interval, etc.).

## POST /v1 returns `status: "error"` with message `"timeout"`

**Symptom:** `maxTimeout` exceeded (per-request timeout set by the client).

**Causes:**

1. **Cloudflare introduced a harder challenge** — Some sites use Turnstile or WAF rules that are harder to bypass. Check the API logs for the actual error.
2. **Pool exhausted** — All browsers are busy. Increase `BROWSER_POOL_SIZE`.
3. **Proxy not working** — If `PROXY_URL` is configured and invalid, Tier 3 will fail consistently. Test HTTP proxies with `curl --proxy "$PROXY_URL" https://nowsecure.nl`. For SOCKS5, test proxy-side DNS explicitly with `curl --proxy socks5h://host:port https://nowsecure.nl`; TRAWL enables the equivalent Firefox remote-DNS preference automatically.

## Prowlarr FlareSolverr test fails

**Symptom:** Green test in isolation but Prowlarr reports the FlareSolverr test as failed.

**Check:**
1. The URL in Prowlarr includes no trailing slash: `http://trawl:8191`
2. Prowlarr can reach the TRAWL container. If they're in different Docker networks, add TRAWL to Prowlarr's network (see [Prowlarr docs](/integrations/prowlarr)).
3. Run `docker exec prowlarr curl -s http://trawl:8191/health` to verify network reachability from inside the Prowlarr container.

## Prowlarr reports `Unable to connect to proxy`

First identify which TRAWL interface Prowlarr is using:

- **FlareSolverr integration:** configure `http://trawl:8191` under **Settings → Indexers →
  FlareSolverr**. Port `8191` is the API and does not require `MITM_ENABLED`.
- **HTTP indexer proxy:** port `8192` is disabled by default. Set `MITM_ENABLED=true`, recreate
  the TRAWL service, and configure an HTTP proxy with host `trawl` and port `8192`. HTTPS targets
  also require TRAWL's CA in the Prowlarr container trust store; see
  [Proxy client setup](/proxy/client-setup#prowlarr).

The supplied Compose service is named `trawl`, not `api`. Check both interfaces from the Prowlarr
container when diagnosing Docker networking:

```bash
docker exec prowlarr curl -fsS http://trawl:8191/health
docker exec prowlarr curl -fsS --proxy http://trawl:8192 http://neverssl.com/ -o /dev/null
```

The second command succeeds only when the optional forward proxy is enabled. If either hostname
lookup fails, attach Prowlarr and TRAWL to the same Docker network before changing application
settings.

## High memory usage / OOM kills

Each Camoufox instance uses 350–500 MB, and temporary contexts or rolling replacement create short peaks. If the API is being killed:

1. Keep `BROWSER_POOL_SIZE=1` for a 1 GB container, or allow at least 2 GB for pool 3
2. Upgrade the server (more RAM or more cores)
3. Ensure `shm_size: 1gb` is set — Firefox uses `/dev/shm` heavily

## Debugging tips

```bash
# Live API logs
docker compose logs -f trawl

# Check Redis keys
docker compose exec redis redis-cli keys "*"

# Test scrape endpoint
curl -s -X POST http://localhost:8191/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | jq '{tier, totalMs}'

# Verify FlareSolverr compat response shape
curl -s -X POST http://localhost:8191/v1 \
  -H "Content-Type: application/json" \
  -d '{"cmd":"request.get","url":"https://nowsecure.nl"}' | jq '{status, version}'
```
