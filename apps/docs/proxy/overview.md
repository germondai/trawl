---
title: Proxy Overview
description: How TRAWL's general HTTP/HTTPS proxy forwards traffic and escalates detected challenges.
---

# Proxy overview

TRAWL can expose a general HTTP/HTTPS forward proxy, normally on port `8192`. It behaves like a
direct proxy for ordinary traffic and invokes the existing `/scrape` tier pipeline only when a
small buffered response looks like a supported challenge.

The proxy is disabled by default. It is intended for trusted clients on localhost, a private LAN,
or a private container network.

## Traffic flow

```text
Client
  │
  ├─ HTTP request ─────────────────────────────┐
  │                                            │
  └─ HTTPS CONNECT → local TLS termination ────┤
                                               ▼
                                      Tier 0 direct forward
                                               │
                      ┌────────────────────────┼────────────────────────┐
                      │                        │                        │
              normal small response     challenge detected      large/media response
                      │                        │                        │
                 buffer + return        run scrape tiers              stream
                                               │
                         Tier 1 → Tier 2 → Tier 3 → Tier 4
                                               │
                                  return solved HTML or raw bytes
```

HTTPS requires local TLS termination so TRAWL can inspect the response body. TRAWL generates a
per-host certificate signed by its own root CA. The client must trust that root certificate.

## Direct forwarding

Tier 0 opens a normal TCP or TLS connection to the destination and forwards the request method,
body, and end-to-end headers. It preserves headers such as:

- `Authorization`, `Cookie`, `User-Agent`, `Referer`, and `Origin`
- custom API headers
- `Range`, `If-Range`, cache validators, and content metadata

Hop-by-hop headers are rebuilt or removed at the proxy boundary.

Responses not selected by the streaming policy-including small HTML, JSON, XML, text, and unknown
small payloads-are buffered. Compressed `gzip`, `deflate`, and Brotli responses are decoded only
for challenge inspection; the original bytes remain the response body. Chunked buffered responses
are de-chunked before being returned.

If an upstream error occurs after a non-safe request may have been sent, the proxy returns
`502` instead of automatically submitting the operation again. Requests that failed before
transmission and safe methods retain scraper fallback. Disconnecting the client closes its
owned direct or streaming upstream connection.

## Challenge escalation

When Tier 0 detects a supported challenge wall, the request is passed to the same `scrape()`
orchestrator used by `POST /scrape`:

1. plain HTTP fetch;
2. cached browser session;
3. fresh browser challenge solve;
4. residential proxy solve, when configured.

Requests with client credentials do not read or populate shared clearance sessions.
For browser solving, client cookies are imported into the request's temporary context
with host-scoped defaults and `Secure` for HTTPS requests. Browser cookie rules apply,
including cookie sharing between ports on the same host. The browser keeps its own
consistent user agent.
`Authorization` is forwarded by the HTTP tiers only. If such a request requires a
browser, the proxy returns `502` rather than forwarding that header through browser
redirects. Use cookies for authenticated browser requests.

For browser-tier complete HTML documents, the proxy returns the rendered solved DOM rather than the
original challenge response. Charset-less UTF-8 HTML fragments with non-ASCII content use the captured
response bytes instead of a serialized browser DOM. Fragments with a doctype, scripts, or event handlers
require matching rendered content and styles. Passive injected scripts are ignored for this comparison;
changed content, solved challenges, embedded documents, and complete HTML documents retain the rendered DOM.
Binary responses use the raw response bytes when the winning tier exposes them.

A hostname that produced a supported challenge wall is cached for five minutes. During that window,
later requests for the hostname skip Tier 0 and go directly to the tiered solver.

Challenge and CAPTCHA solving is best effort. A site can still reject the browser, require user
interaction, bind clearance to an unsupported signal, or change its challenge implementation.
When the final browser tier stops on such a wall, the proxy returns its bounded rendered HTML with
the upstream status code and `X-Trawl-Status: blocked` instead of disguising it as a gateway outage.
`X-Trawl-Reason` identifies the detected wall when available. Network, browser-pool, and other
infrastructure failures still return `502 Bad Gateway`.

## Buffering and streaming

The proxy buffers ordinary responses by default so challenge detection sees the complete body.
It streams when at least one of these applies:

- `Content-Length` is at least 8 MiB;
- an unknown-length response reaches the same 8 MiB buffer threshold;
- the content type is `video/*` or `audio/*`;
- an unknown-length response has a known binary content type;
- the URL has a known media, archive, installer, disk-image, PDF, or font extension.

Streaming keeps large files out of TRAWL's memory. Streamed responses bypass body-based challenge
detection, so the policy intentionally targets content that is unlikely to be an HTML challenge.

`Range` requests are forwarded unchanged. A compliant upstream `206 Partial Content` response,
including `Content-Range` and `Accept-Ranges`, is passed back to the client. If the Range response
is instead a detectable challenge page, it can escalate through the normal solver pipeline.

## WebSockets

HTTP and HTTPS WebSocket upgrade requests use a bidirectional byte relay after the upstream
`101 Switching Protocols` response. WebSocket frames are not buffered or interpreted.

The WebSocket handshake does not escalate through the browser solver. If a WebSocket endpoint
requires a clearance cookie, the client must already have suitable credentials or obtain them
through a preceding solved HTTP flow.

## Current protocol boundaries

The current listener is an HTTP/1.1 proxy:

- one request is served per proxied TLS connection;
- HTTP keep-alive and pipelining are not reused;
- request bodies use `Content-Length`; chunked uploads are not decoded;
- duplicate upstream response headers are represented by the first observed value;
- proxy authentication is not implemented;
- HTTP/2 and HTTP/3 are not terminated between the client and TRAWL.

On a challenged request, the browser fallback converts a request body to UTF-8 because the public
scrape contract currently accepts a string body. Ordinary direct forwarding preserves binary
request bodies exactly.

## Proxy versus API endpoints

| Interface          | Best for                                     | Response handling                                       |
| ------------------ | -------------------------------------------- | ------------------------------------------------------- |
| `POST /v1`         | FlareSolverr-compatible integrations         | Returns HTML, cookies, and user agent                   |
| `POST /scrape`     | Native programmatic scraping                 | Returns tier metadata and solved content                |
| HTTP proxy `:8192` | Applications that perform their own requests | Forwards HTTP traffic and escalates detected challenges |

Use `/v1` or `/scrape` when the application explicitly supports a solver API. Use the proxy when the
application only knows how to make ordinary HTTP requests or when cookie handoff is not sufficient.
