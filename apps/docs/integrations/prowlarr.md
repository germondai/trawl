---
title: Prowlarr
description: Connect Prowlarr to TRAWL as a FlareSolverr replacement.
---

# Prowlarr

TRAWL implements the FlareSolverr v2 API exactly, including the `version: "2.0.0"` field that Prowlarr validates. No plugins or code changes required - it's a URL swap.

## Empty cookies after a successful scrape

Prowlarr uses the returned cookies and User-Agent for its own request. If TRAWL can
retrieve the page over HTTP without cookies, Prowlarr may still report
`Empty cookies returned by FlareSolverr`.

Set `FLARESOLVERR_COOKIE_FALLBACK=true` in TRAWL's environment and recreate the container
to try one browser-backed GET when this happens. The option is off by default and keeps
later HTTP clearance reuse. See [Cookie Handoff](/getting-started/configuration#flaresolverr-cookie-handoff)
for limits and cases where cookies cannot be transferred between clients.

The proxy's **Test** uses Prowlarr's public ping endpoint. A successful HTTP `Pong`
response passes without cookies; indexer requests retain the cookie fallback.

## Setup

This is the recommended FlareSolverr-compatible integration. It uses TRAWL's API on port `8191`;
the optional forward proxy on port `8192` is a separate mode.

1. Open Prowlarr and go to **Settings → Indexers**
2. Scroll to the **FlareSolverr** section
3. Set the URL to your TRAWL API address:

   ```
   http://localhost:8191
   ```

   If running via Docker Compose on the same host as Prowlarr:
   ```
   http://trawl:8191
   ```

4. Leave all other fields at their defaults
5. Click **Test** - you should see a green tick
6. Click **Save**

## Verification

After saving, trigger a search on a protected indexer. TRAWL handles recognized Cloudflare, Akamai,
and Imperva walls through its tier engine. Later searches can reuse the saved session while the
target continues to accept it.

## Prowlarr inside Docker

If Prowlarr runs inside Docker on the same host, use the Docker network name instead of `localhost`:

```yaml
# docker-compose.yml (your Prowlarr stack)
services:
  prowlarr:
    image: lscr.io/linuxserver/prowlarr:latest
    environment:
      - FLARESOLVERR_URL=http://trawl:8191
    networks:
      - trawl_default  # join TRAWL's network

networks:
  trawl_default:
    external: true
```

Or use the host's IP address directly:

```
http://host.docker.internal:8191  # Mac/Windows Docker Desktop
http://172.17.0.1:8191            # Linux Docker default bridge
```

## Troubleshooting

**Test fails with "connection refused"**

The API container isn't running or the port is wrong. Run `docker compose logs trawl` and check the port mapping with `docker compose ps`.

**Prowlarr reports "Unable to connect to proxy"**

If you configured TRAWL under **Settings → Indexer Proxies → HTTP** rather than as a
FlareSolverr service, you are using the optional forward proxy. Enable it with
`MITM_ENABLED=true`, recreate the `trawl` service, use port `8192`, and install TRAWL's CA in
the Prowlarr container for HTTPS targets. See [Proxy client setup](/proxy/client-setup#prowlarr).

**Test succeeds but searches still fail**  
Some indexers use a different domain than their main site. TRAWL caches cookies per hostname - the first request to each subdomain takes the full challenge time.

**`version` mismatch error in Prowlarr logs**  
This should not happen - TRAWL always returns `"version": "2.0.0"`. If you see it, check you're not running an old build with a cached layer: `docker compose pull && docker compose up -d`.
