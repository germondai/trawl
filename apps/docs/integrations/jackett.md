---
title: Jackett
description: Use TRAWL as a FlareSolverr drop-in with Jackett.
---

# Jackett

Jackett reads its FlareSolverr URL from `ServerConfig.json`. TRAWL is a drop-in replacement.

## Setup via UI

1. Open the Jackett web UI → **Dashboard**
2. Click the **≡** menu → **Settings**
3. Find the **FlareSolverr API URL** field
4. Enter:
   ```
   http://localhost:8191
   ```
5. Click **Apply server settings**

## Setup via config file

Edit `~/.config/Jackett/ServerConfig.json` (or wherever your Jackett data directory is):

```json
{
  "FlareSolverrUrl": "http://localhost:8191",
  ...
}
```

Restart Jackett after editing the file.

## Verify

Navigate to any Cloudflare-protected indexer in Jackett and click **Test**. The first test triggers a full challenge solve (~10–30s). Subsequent tests on the same domain return in ~500ms from the TRAWL session cache.

## Docker

```yaml
services:
  jackett:
    image: lscr.io/linuxserver/jackett:latest
    environment:
      - FLARESOLVERR_URL=http://trawl:8191
```

## Notes

Jackett does not verify the `version` field in the FlareSolverr response the same way Prowlarr does. Either way, TRAWL returns `"2.0.0"` which is correct.
