---
title: "*arr Apps"
description: Connect Sonarr, Radarr, Lidarr, Readarr and other *arr apps via Prowlarr or Jackett.
---

# *arr Apps

Sonarr, Radarr, Lidarr, and Readarr do not talk to FlareSolverr directly. They go through **Prowlarr** (recommended) or **Jackett** as an indexer proxy. You only need to configure TRAWL once in the indexer manager — all *arr apps that use that manager get Cloudflare bypass automatically.

## Recommended setup

```
Sonarr / Radarr / Lidarr / Readarr
         │
         ▼
      Prowlarr  ← configure TRAWL here
         │
         ▼
      TRAWL
```

Configure TRAWL in Prowlarr following the [Prowlarr guide](/integrations/prowlarr), then add Prowlarr as an indexer source in each *arr app normally. No TRAWL configuration is needed in the *arr apps themselves.

## Sonarr

1. **Settings → Indexers → Add Indexer → Prowlarr**
2. Enter your Prowlarr URL and API key
3. Click **Test** then **Save**

Sonarr will now route all indexer searches through Prowlarr, which uses TRAWL for any Cloudflare-protected trackers.

## Radarr

Same steps as Sonarr. **Settings → Indexers → Add → Prowlarr**.

## Lidarr

Same pattern. Lidarr supports Prowlarr natively since v1.3.

## Readarr

Same pattern. **Settings → Indexers → Add → Prowlarr**.

## Bazarr

Bazarr uses subtitle providers, not torrent indexers, so it does not use FlareSolverr at all. No TRAWL configuration needed.

## Performance expectations

| Request type                                     | Expected time                  |
| ------------------------------------------------ | ------------------------------ |
| First request to a domain                        | 4–15s (fresh Cloudflare solve) |
| Repeat request (same domain, session cached)     | ~500ms                         |
| Plain site (no Cloudflare)                       | < 100ms                        |
| IP flagged by Cloudflare (Tier 4, if configured) | 15–45s                         |

The session cache TTL is configurable via `SESSION_TTL_SECONDS` (default 1 hour). Most Cloudflare-protected indexers re-challenge after 30–60 minutes, so daily search schedules in *arr apps almost always hit the cache.
