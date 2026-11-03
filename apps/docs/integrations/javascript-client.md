---
title: JavaScript Client
description: Use TRAWL's native API from Node.js, Bun, Deno and browser applications.
---

# JavaScript client

`@trawl/client` is the independently versioned SDK workspace in this repository.
Its first npm publication is a separate release step. You can build and install
a tarball now; see the [package guide](https://github.com/germondai/trawl/blob/main/packages/client/README.md).

The SDK uses ofetch with automatic retries disabled. It supports Node.js 22+, Bun,
Deno 2 and modern browsers, with ESM, CommonJS and TypeScript declarations.

```ts
import { Trawl } from "@trawl/client"

const trawl = new Trawl({ baseURL: "http://localhost:8191" })
const page = await trawl.scrape({
  url: "https://nopecha.com/demo/cloudflare",
  maxTimeout: 60_000,
})

console.log(page.html, page.timings)
```

Use all [native scrape options](/api-reference/native-api), including screenshots,
response capture, MHTML, favicons and blocked evidence. Results preserve the target
status as `statusCode`; failed API requests throw a `TrawlError`.

For a JSON target request, pass an object or array directly:

```ts
await trawl.scrape({
  url: "https://example.com/search",
  method: "POST",
  body: { query: "developer", page: 1 },
})
```

The SDK serializes it and supplies the target JSON Content-Type if absent. String
bodies and explicit content types are preserved; non-empty strings still need a
target Content-Type. The same convenience is available for content methods and
session scraping. The native HTTP API's body remains a string.

## Read, extract and inspect

```ts
const article = await trawl.read({ url: "https://example.com/article", format: "markdown" })
console.log(article.title, article.text)

const records = await trawl.extract({
  url: "https://example.com/articles",
  itemSelector: ".card",
  fields: { title: { selector: "h2" }, link: { selector: "a", attribute: "href" } },
  render: true,
  contentWaitForSelector: ".card",
})
console.log(records.items)

const image = await trawl.screenshot({ url: "https://example.com", screenshotFullPage: true })
const diagnostics = await trawl.inspect({ url: "https://example.com" })
```

`read()` and `extract()` use the new [native content endpoints](/api-reference/page-content),
which share processing and limits with MCP. They require a server build containing
these endpoints; released servers without them return 404. Parsing runs on the
server, so the client does not install HTML or Markdown parsers.

`screenshot()` and `inspect()` enable the relevant browser options on `/scrape` and
return the full scrape result. Screenshot requires an actual base64 JPEG; inspect
provides console, network and redirect arrays. All four methods accept `sessionId`
and client cancellation options.

## Browser sessions

```ts
const session = await trawl.sessions.create({ keepPage: true })
try {
  await session.scrape({ url: "https://example.com/account" })
  console.log(await session.eval("document.title"))
  console.log(await session.cookies())
} finally {
  await session.close()
}
```

The handle represents a remote [browser session](/api-reference/browser-sessions).
Keep operations within one session sequential. Existing session IDs can be used
through `trawl.sessions.scrape(id, options)`, `.eval(id, expression)`, `.cookies(id)`
and `.destroy(id)`.

## Authentication and frontend use

An optional `apiKey` sends `Authorization: Bearer ...` to the configured TRAWL API.
It requires a server or gateway that actually verifies the key; the current
self-hosted API does not provide general API authentication.

For frontend applications, keep long-lived keys on your backend and authorize the
user's request there. Direct browser access requires appropriate CORS configuration
on a gateway. Target-site headers belong inside `scrape({ headers })`, separately
from headers used to authenticate the SDK connection.

## Timeouts

`scrape`, `read`, `extract` and `inspect` receive `waf` provider metadata by default.
Pass `detectWaf: false` to opt out. It is an offline diagnostic and does not change solver routing.
On a failed scrape the SDK exposes the same metadata as `TrawlError.waf`.
See [WAF identification](/api-reference/native-api#waf-identification) for worker setup and limits.

```ts
await trawl.scrape(
  { url: "https://example.com", maxTimeout: 60_000 },
  { timeoutMs: 70_000, signal: controller.signal },
)
```

`maxTimeout` limits the server operation; `timeoutMs` limits the client connection,
including reading the response. A client abort does not guarantee immediate server
cancellation. The [package guide](https://github.com/germondai/trawl/blob/main/packages/client/README.md)
covers error handling, connection options and local packaging.
