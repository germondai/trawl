---
title: Model Context Protocol (MCP)
description: Connect any MCP-compatible AI client to TRAWL's scraping tool.
---

# Model Context Protocol (MCP)

TRAWL has an optional, client-independent Model Context Protocol server. Any AI
application or agent that supports remote MCP servers over Streamable HTTP can
connect to it and use its reading, scraping, extraction, screenshot and inspection tools.

This is a scraper, not a web search engine. The caller must already know the URL.
Search discovery and reranking require a separate provider such as SearXNG; TRAWL
can then load the selected result URLs.

## Enable the endpoint

```ini
MCP_ENABLED=true
```

The endpoint is `http://<trawl-host>:8191/mcp`. Keep it on a private network. MCP
v1 has no authentication and is not supported as a public internet endpoint. If a
browser-based client calls it directly, add the exact origin:

```ini
MCP_ALLOWED_ORIGINS=https://chat.example.com
```

Requests without an `Origin` header are supported for server-to-server clients.
Use the following generic connection details in your MCP client:

```text
Name: trawl
Transport: Streamable HTTP
URL: http://trawl:8191/mcp
```

The exact configuration syntax belongs to the client. If the client blocks private
network addresses by default, allow the TRAWL hostname or address in that client's
network policy. TRAWL does not require or assume any specific AI frontend.

## Tools

TRAWL exposes a small set of purpose-specific, read-only tools:

| Tool | Use it for |
| --- | --- |
| `read` | Extracting the main page content as Markdown or plain text |
| `scrape` | Reading the original HTML and scrape metadata |
| `extract` | Selecting text or attributes from repeated page elements into JSON records |
| `screenshot` | Rendering a viewport, full-page or selected-element JPEG |
| `inspect` | Browser console, network timing and redirect diagnostics |
| `scrape_url` | Backwards-compatible alias for `scrape` |

Every tool requires a public HTTP(S) `url` and optionally accepts `maxTimeout`
and `maxTier`. `scrape` also accepts `skipHttp`. Browser-only tools start at
Tier 2 and accept a `maxTier` from 2 through 4.

`read` defaults to Markdown and a 50,000-character response. Set `format` to
`text` for plain text, or set `maxCharacters` to a value from 1 through 100,000.
Its structured metadata includes the title and, when detected, the byline,
excerpt, site name and language.

For non-HTML text documents such as TXT, JSON and XML, `read` returns the file
text directly for either format, subject to `maxCharacters`. Whitespace and empty
files are preserved. TRAWL uses the declared HTTP charset, falling back to UTF-8
when it is absent or unsupported. HTML pages continue to use article extraction.

`scrape` returns at most 50,000 characters of page HTML. Its structured output
includes the final URL, status, winning tier, content type, elapsed time,
per-tier attempt history, cache use, truncation and non-sensitive CAPTCHA/proxy
booleans. The attempt history contains only tier, status, duration and an optional
reason; response headers, bodies and cookies are excluded.

`extract` accepts `fields`, an object of field names mapped to `{ selector,
attribute? }`. The selector is a CSS selector and returns trimmed text unless an
HTML attribute is named. Set `itemSelector` to select repeated rows; field
selectors then run inside each row. Without it, one record is extracted from the
whole page. Missing elements or attributes become `null`. The tool returns raw
attribute values, so relative links remain relative. It defaults to 25 records
and allows up to 100; at most 20 fields, 2 million HTML characters and 100,000
output characters are processed. Set `render: true` to start with a browser for
JavaScript-rendered pages. `waitForSelector` also enables browser rendering and
waits up to 10 seconds, within the request budget, for a visible element before
the HTML is read. If it does not appear, extraction runs on the current HTML.
These options require `maxTier` to be at least 2. For example:

```json
{
  "url": "https://example.com/products",
  "waitForSelector": ".product",
  "itemSelector": ".product",
  "fields": {
    "name": { "selector": "h2" },
    "link": { "selector": "a", "attribute": "href" }
  }
}
```

`screenshot` returns an MCP `image` content block containing a base64 JPEG plus
structured scrape metadata. A client and its selected model must support image
tool results to make visual use of it. It captures the viewport by default.
Set `fullPage: true` to capture the whole page, limited to 6,000 pixels in height
and 12 million pixels total. Set `waitForSelector` to wait up to 10 seconds for
a visible CSS selector before capture. All screenshots retain the configured
capture timeout and 4 MB default output limit. An oversized or failed capture
returns a tool error. Set `selector` to capture the first visible matching
element, such as a table or chart, using the same limits. `selector` and
`fullPage` cannot be combined.

`inspect` returns the bounded diagnostics already collected by TRAWL's browser
tiers. Credentials, query strings and fragments are stripped from network and
redirect URLs. Console messages are page-controlled and can themselves contain
tokens or personal data, so treat this explicit diagnostic tool as sensitive.

Private, loopback, link-local, and reserved destinations are rejected, including
redirect destinations and browser-loaded subresources. Request
headers, bodies, cookies, session IDs, and explicit proxies cannot be supplied by
the model.

Cookies, request headers, response bodies captured from background APIs, explicit
proxy details, browser identity and session data are never returned by these MCP
tools.
