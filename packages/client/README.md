# @trawl/client

A typed HTTP client for TRAWL's native API. Uses ofetch and standard Web APIs in
Node.js 22+, Bun, Deno 2 and modern browsers. Both ESM and CommonJS exports include
TypeScript declarations. The client does not install or launch a browser.

## Build and install locally

The first npm publication is a separate release step. From the repository root:

```sh
bun install --frozen-lockfile
bun --cwd packages/client build
npm pack ./packages/client --ignore-scripts
npm install ./trawl-client-0.1.0.tgz
```

After publication, install with `npm install @trawl/client`, `bun add @trawl/client`
or `deno add npm:@trawl/client`.

## Scrape

```ts
import { Trawl } from "@trawl/client"

const trawl = new Trawl({ baseURL: "http://localhost:8191" })
const page = await trawl.scrape({
  url: "https://nopecha.com/demo/cloudflare",
  maxTimeout: 60_000,
  screenshot: true,
})

console.log(page.html, page.totalMs, page.timings)
```

All native scrape options are available, including cookies, an upstream proxy,
screenshots, response capture, MHTML, favicons and blocked evidence. Requests return
`ScrapeResponse`, the JSON API representation. Its optional `body` is a numeric-keyed
object, not a `Uint8Array`; use `html` for the decoded text.

Offline WAF provider metadata appears in `page.waf` by default on supported servers.
Set `detectWaf: false` to opt out, or disable it instance-wide with `WAF_DETECTION_ENABLED=false`.
It identifies signatures without changing challenge solving. Failures retain the
metadata in `TrawlError.waf`. This feature requires the server changes
under Unreleased and its local wafmeow helper; older servers may omit the field.

### Send JSON to the target

```ts
await trawl.scrape({
  url: "https://example.com/search",
  method: "POST",
  body: { query: "developer", page: 1 },
})
```

A plain object or array in `body` is JSON-serialized and gets a target
`Content-Type: application/json` unless you supplied a Content-Type header.
The SDK does not change the target method or mutate your options. This works with
scrape, read, extract, browser helpers and session scraping.

String bodies are forwarded unchanged and still need an explicit target
Content-Type when non-empty. Use strings for form-encoded, XML or other raw text.
FormData, binary buffers, streams and other non-plain objects are not automatically
encoded; unsupported or unserializable bodies reject with TypeError before sending.
The native HTTP API continues to receive a string body; this convenience belongs
to the SDK. Constructor headers authenticate the API connection, separately from
the target headers in the scrape options.

## Read, extract and browser helpers

```ts
const article = await trawl.read({
  url: "https://example.com/article",
  format: "markdown", // or "text"
  maxCharacters: 20_000,
})
console.log(article.title, article.text, article.truncated)

const records = await trawl.extract({
  url: "https://example.com/articles",
  itemSelector: ".card",
  fields: {
    title: { selector: "h2" },
    link: { selector: "a", attribute: "href" },
  },
  maxItems: 25,
  render: true,
  contentWaitForSelector: ".card",
})
console.log(records.items, records.matched, records.truncated)

const image = await trawl.screenshot({ url: "https://example.com", screenshotFullPage: true })
console.log(image.screenshot) // base64 JPEG

const diagnostics = await trawl.inspect({ url: "https://example.com" })
console.log(diagnostics.consoleLogs, diagnostics.networkLogs, diagnostics.redirectChain)
```

`read()` and `extract()` call the native `/read` and `/extract` endpoints. The server
shares their content processing and limits with MCP. Read defaults to Markdown with
50,000 characters, capped at 100,000. Extraction accepts 1-20 fields and 1-100 records
(25 by default); missing values are `null` and attributes are returned as written.
These responses contain content and page metadata, without the raw HTML or cookie jar.

`screenshot()` and `inspect()` call `/scrape` once and force browser rendering.
They use the native option names and return the full scrape result; screenshot
requires an actual image or throws a `TrawlError` with kind `protocol`. Browser
helpers require `maxTier` 2 or higher. Native diagnostics can contain sensitive
URLs and page logs.

All four methods accept `sessionId` and the same second argument for client
timeouts and cancellation as `scrape()`. Set `render: true` for JavaScript-driven
extraction; `contentWaitForSelector` also implies rendering on `/extract`.

## Sessions

```ts
const session = await trawl.sessions.create({ keepPage: true })
try {
  await session.scrape({ url: "https://example.com/account" })
  const title = await session.eval("document.title")
  const cookies = await session.cookies()
  console.log(title, cookies)
} finally {
  await session.close()
}
```

`session.id` identifies the remote session. `session.details` is an immutable
creation snapshot; use `trawl.sessions.list()` for current metadata. The server
controls session expiry and concurrency: operations in one session must be
sequential, and a busy session can return HTTP 409. Eval requires `keepPage: true`.
Create sessions intended for MCP with `publicOnly: true`; ordinary sessions keep
trusted-operator access to private targets and cannot be used by MCP.

For a saved ID, use `trawl.sessions.scrape(id, options)`, `.eval(id, expression)`,
`.cookies(id)` and `.destroy(id)`. Session creation and deletion are not retried.

## Connection options

`new Trawl()` defaults to `http://localhost:8191`. Options:

| Option | Purpose |
| --- | --- |
| `baseURL` | HTTP(S) API URL, including an optional reverse-proxy path prefix. Browsers may use a root-relative prefix. |
| `apiKey` | Optional bearer token for a gateway or instance that verifies API keys. |
| `headers` | Additional headers sent to the TRAWL API. These are separate from target-site `scrape({ headers })`. |
| `timeoutMs` | Optional client deadline, including response-body consumption. |
| `fetch` | Optional implementation of the standard fetch function. |

Credentials, query strings and fragments are rejected in `baseURL`. API redirects
are not followed; configure the final API URL. This avoids sending a key or replaying
a scrape to an unexpected endpoint.

TRAWL currently has no general API-key authentication. Providing `apiKey` only
sends a header; it does not secure an open server. Use an authenticated gateway or
private network. Keep long-lived keys in backend configuration. For browser apps,
prefer an application backend that authorizes requests and calls TRAWL. Direct
cross-origin browser access requires CORS on that gateway; the SDK cannot add it.

## Deadlines and cancellation

```ts
await trawl.scrape(
  { url: "https://example.com", maxTimeout: 60_000 },
  { timeoutMs: 70_000, signal: controller.signal },
)
```

The first argument is sent to TRAWL. The second controls the client connection and
is also accepted by session operations, `info()`, `health()` and `stats()`.
Session eval accepts `{ maxTimeout, timeoutMs, signal }` as its options argument.

`maxTimeout` bounds server work; `timeoutMs` bounds the client request. There is no
extra client deadline unless configured. Set the client deadline above the server
budget when you need its full error response. Aborting the client does not guarantee
immediate cancellation on the server. Automatic retries are disabled for every method.

## Errors and instance information

```ts
import { TrawlError } from "@trawl/client"

try {
  await trawl.scrape({ url: "https://example.com", blockedEvidence: true })
} catch (error) {
  if (error instanceof TrawlError) {
    console.error(error.kind, error.status, error.message)
    console.log(error.timings, error.blockedEvidence)
  }
}
```

Error kinds: `api`, `network`, `timeout`, `aborted`, `protocol`. API errors retain
the response in `data` and any `Retry-After` header in `retryAfter`. Request options
and transport errors containing credentials are not retained. Server response data
may contain sensitive page content; decide what your application can log.

`result.statusCode` is the target website's status. A fetched 404 or 502 can be a
valid API result. Failed API requests throw instead. `health()` also throws while
the server returns HTTP 503; its parsed readiness response is available in `error.data`.

Use `info()`, `health()` and `stats()` for the current instance. MCP and the MITM
forward-proxy protocol use their own integrations; this package calls the native
JSON API. Core SDK operations target TRAWL 1.9.1 and newer. The new `read()` and
`extract()` endpoints require the server changes currently under Unreleased;
earlier releases return HTTP 404. The client does not silently repeat the operation
through another endpoint.
