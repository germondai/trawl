---
title: Proxy Configuration
description: Enable and configure TRAWL's challenge-bypassing HTTP/HTTPS proxy.
---

# Proxy configuration

## Environment variables

| Variable                   | Default          | Purpose                                                  |
| -------------------------- | ---------------- | -------------------------------------------------------- |
| `MITM_ENABLED`       | `false`          | Starts the forward-proxy listener                        |
| `MITM_HOST`          | `0.0.0.0`        | Listener bind address                                    |
| `MITM_PORT`          | `8192`           | Listener port                                            |
| `MITM_CA_DIR`        | `/data/proxy-ca` | Persistent root CA certificate and private-key directory |
| `MITM_MAX_TIER`      | `4`              | Highest solver tier available to proxy escalation        |
| `MITM_ALWAYS_SCRAPE` | `false`          | Skip direct Tier 0 and enter the scraper immediately     |
| `MITM_ESCALATE_429` | `false` | Try scraping after an unrecognized proxy HTTP 429 response |
| `MITM_DEBUG`         | `false`          | Logs proxied requests and tier attempts                  |
| `SCRAPE_MIN_TIER`    | `1`              | Lowest tier once a request enters the scraper ladder     |
| `SCRAPE_PROXY_SELECTION` | `failover`   | Tier 3/4 pool policy: failover, round-robin, or random   |

Example:

```ini
MITM_ENABLED=true
MITM_HOST=127.0.0.1
MITM_PORT=8192
MITM_CA_DIR=/data/proxy-ca
MITM_MAX_TIER=4
MITM_ALWAYS_SCRAPE=false
MITM_ESCALATE_429=false
SCRAPE_MIN_TIER=1
SCRAPE_PROXY_SELECTION=failover
MITM_DEBUG=false
```

Use `127.0.0.1` for a local installation. Docker clients on a bridge network normally require
`0.0.0.0`; restrict access with container networking or a host firewall.

`MITM_MAX_TIER=3` prevents proxy requests from consuming a configured residential Tier 4
proxy. An empty or invalid value uses the normal maximum of Tier 4.

Set `MITM_ALWAYS_SCRAPE=true` for targets where the proxy's initial direct Tier 0 request is
itself enough to trigger a temporary ban. This skips only proxy Tier 0: the normal scraper ladder
starts at `SCRAPE_MIN_TIER` and escalates when necessary. To prevent both Tier 0 and Tier 1 traffic,
set `MITM_ALWAYS_SCRAPE=true` together with `SCRAPE_MIN_TIER=2`. WebSocket upgrades remain direct
relays.

Always-scrape mode also bypasses Tier 0's media and large-file streaming path. Do not enable it on
a general download or media proxy: video, archives, Range requests, and other large responses may
instead be buffered by the scraper, and request bodies pass through the scraper's text-oriented
request interface. Prefer a separate TRAWL instance or narrowly scoped proxy rule for affected
sites.

## Google Search challenge redirects

Tier 0 recognizes HTTP 301, 302, 303, 307 and 308 redirects to `/sorry` or `/sorry/` on `google.com`, `www.google.com`, `ipv4.google.com` and `ipv6.google.com`. It enters the existing scraper ladder using the original request URL, without following the redirect in the direct forwarder. Absolute, protocol-relative and relative destinations are resolved against the request URL.

Ordinary search redirects, login redirects and unrelated hosts remain direct responses. Tier 1 also escalates final responses on these challenge URLs; browser tiers report `google-sorry-persistent` when the final URL is still the challenge, rather than returning it as successful content. Existing tier limits, outbound validation and TLS checks still apply. This does not add a new CAPTCHA solver or guarantee that Google will accept the browser or its IP. Other Google country domains are not covered by this rule.

## Optional HTTP 429 escalation

Set `MITM_ESCALATE_429=true` to treat otherwise unrecognized HTTP 429 responses from proxy Tier 0 as blocked and try the existing scraper ladder. The flag is off by default, applies to HTTP and HTTPS proxy traffic, and does not change the native API, which already treats 429 as blocked. Recognized challenges retain their existing handling.

A plain 429 does not mark the entire host as challenged in the routing cache. If scraping fails or returns another error response, the proxy forwards the original 429 body and headers, including `Retry-After`. Successful responses and ordinary downloads keep their direct forwarding path.

This can repeat requests and acquire a browser. It does not reset a site's rate limit or guarantee a successful response. Existing tier limits, outbound validation, proxy routing, and TLS checks still apply. `MITM_ALWAYS_SCRAPE` bypasses Tier 0 entirely, so there is no direct response for this flag to inspect in that mode. WebSocket upgrades remain direct relays.

## Docker Compose

The supplied Compose files publish the API and proxy ports and persist the root CA:

```yaml
services:
  trawl:
    ports:
      - "8191:8191"
      - "8192:8192"
    environment:
      MITM_ENABLED: "true"
      MITM_HOST: 0.0.0.0
      MITM_PORT: 8192
      MITM_CA_DIR: /data/proxy-ca
      MITM_ALWAYS_SCRAPE: "false"
      SCRAPE_MIN_TIER: "1"
    volumes:
      - trawl_proxy_ca:/data/proxy-ca

volumes:
  trawl_proxy_ca:
```

Start or recreate the service after changing proxy variables:

```bash
docker compose up -d --force-recreate trawl
```

## Upstream proxy interaction

Tier 0 direct traffic leaves from the TRAWL host directly. `PROXY_URL` and
`RESIDENTIAL_PROXY_URL` apply when a challenged request escalates into the scrape tiers; they do
not turn the entire forward proxy into a chain through another proxy.

The normal sticky-per-domain rotation and failure cooldown rules apply during escalation. Use
`MITM_MAX_TIER` to cap which tiers the forward proxy may reach.

## Verify the listener

Download the CA and test an HTTPS request:

```bash
curl http://127.0.0.1:8191/proxy-ca.crt -o trawl-ca.crt
curl --proxy http://127.0.0.1:8192 \
  --cacert ./trawl-ca.crt \
  https://example.com/
```

Test plain HTTP:

```bash
curl --proxy http://127.0.0.1:8192 http://neverssl.com/
```

Test Range forwarding:

```bash
curl --proxy http://127.0.0.1:8192 \
  --cacert ./trawl-ca.crt \
  -H 'Range: bytes=0-99' \
  -D - https://httpbin.org/range/1024
```

The Range request should return `206` and a 100-byte body when the upstream supports it.

## Debug logging

Set `MITM_DEBUG=true` to log direct forwarding, streaming decisions, challenge escalation,
winning scrape tiers, statuses, content types, and payload sizes. Disable it after troubleshooting;
general proxy clients can generate a large volume of requests.

The proxy has no authentication layer. Never publish port `8192` directly to the internet.
