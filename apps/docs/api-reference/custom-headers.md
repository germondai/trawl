---
title: Custom Headers
description: Pass custom HTTP headers through TRAWL to the target URL across all execution tiers.
---

# Custom Headers

Both `/v1` and `/scrape` accept an optional `headers` object. Headers are forwarded to the target URL across all four execution tiers.

## Usage

**`/v1` (FlareSolverr-compat)**

```json
{
  "url": "https://example.com",
  "headers": {
    "Authorization": "Bearer my-token",
    "Referer": "https://parent-site.com"
  }
}
```

**`/scrape` (native API)**

```json
{
  "url": "https://example.com",
  "headers": {
    "X-API-Key": "secret",
    "Origin": "https://trusted-site.com"
  }
}
```

Custom headers are merged **after** browser defaults, so they take precedence over anything like `User-Agent` or `Cache-Control` that TRAWL sets internally.

## How headers are applied per tier

| Tier | Mechanism | Scope |
|------|-----------|-------|
| **Tier 1** — plain HTTP fetch | Spread into `fetch()` headers | All requests (there is only one) |
| **Tier 2** — cached browser session | `page.route(url, ...)` interception | Main document request only |
| **Tier 3** — fresh CF challenge solve | `page.route(url, ...)` interception | Main document request only |
| **Tier 4** — residential proxy escalation | `page.route(url, ...)` interception | Main document request only |

For browser tiers, route interception is scoped to the **exact target URL**. Subresources (JS, CSS, images, fonts, third-party CDNs) and Cloudflare challenge endpoints (`cdn-cgi/*`) are never intercepted — your `Authorization` header does not leak to third parties, and CF challenge solving is unaffected.

## CF challenge + custom headers flow

When a page requires both challenge bypass and custom headers, the sequence is:

```
1. page.goto(url) — route fires, custom headers added to initial request
2. CF intercepts → serves JS challenge interstitial
3. Challenge scripts run on cdn-cgi/* paths → route never fires, CF sees clean requests
4. cf_clearance cookie issued → browser redirects back to original url
5. route fires again → custom headers applied to the real page load ✓
```

## Common use cases

| Use case | Header |
|----------|--------|
| Authenticated APIs and portals | `Authorization: Bearer <token>` |
| Embed-only / iframe-restricted content | `Referer: https://parent-site.com` |
| CORS-restricted endpoints | `Origin: https://allowed-site.com` |
| Custom API keys | `X-API-Key: <key>` |
| Additional session tokens | `Cookie: session=<value>` |

::: tip Cookie behaviour
Passing a `Cookie` header appends to any cookies the browser already holds (CF clearance, cached session cookies). It does not replace them.
:::

::: warning Headers and CF-protected pages
Pages that require custom auth headers are rarely also behind CF JS challenges — CF challenges are for public sites needing bot/DDoS protection, while auth headers imply a private/restricted resource. If you hit both, TRAWL handles it correctly as described above.
:::
