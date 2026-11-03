# TRAWL client examples

The client package has not been published yet. Build it from the repository root:

```sh
bun install --frozen-lockfile
bun --cwd packages/client build
```

The native `/read` and `/extract` endpoints require the new server implementation
currently under Unreleased. Existing releases without them return 404.

## Runnable demos

`demo.ts` runs one job and saves results to a fresh temporary directory. It does
not dump cookies or page contents to the terminal. Node/Bun file APIs are used for
output; the HTTP client itself is also compatible with Deno and browser bundles.

```sh
bun packages/client/examples/demo.ts scrape https://nopecha.com/demo/cloudflare
bun packages/client/examples/demo.ts read https://example.com
bun packages/client/examples/demo.ts extract https://example.com
bun packages/client/examples/demo.ts screenshot https://example.com
bun packages/client/examples/demo.ts inspect https://example.com
bun packages/client/examples/demo.ts capture https://example.com
bun packages/client/examples/demo.ts session https://example.com
```

Available environment variables:

| Variable | Purpose |
| --- | --- |
| `TRAWL_BASE_URL` | API URL; defaults to `http://localhost:8191` |
| `TRAWL_API_KEY` | Optional key for an authenticated API gateway |
| `TRAWL_PROXY_URL` | Optional target proxy; session mode sets it at creation |
| `TRAWL_DEMO_OUTPUT_DIR` | Explicit output directory instead of a private temporary one |
| `TRAWL_ITEM_SELECTOR` | Repeated item selector for the extract demo |
| `TRAWL_CAPTURE_PATTERN` | Response URL substring for capture; defaults to `/api/` |

The default extract demo uses `h1, h2` and `a` as field selectors. Capture may
legitimately return an empty array when the page makes no matching request.
Adapt selectors and response patterns to the target site.

`backend.ts` serves a small browser demo on localhost. It keeps the API key on the
server, reads one configured source URL, caches it for one minute and shares an
in-flight request between concurrent visitors:

```sh
TRAWL_SOURCE_URL=https://example.com bun packages/client/examples/backend.ts
```

Open the URL printed by the server. This example binds to `127.0.0.1` and is a
local demo; a deployed application should use its own user authorization and
request limits. The source URL is configured by the application, not accepted
from arbitrary browser input.

## Common setup for the snippets

The remaining examples use the following server-side instance. `.example` domains
and CSS selectors illustrate adapters for your own targets; they do not identify
tested live sites.

```ts
import { Trawl, TrawlError } from "@trawl/client"

const trawl = new Trawl({
  baseURL: process.env.TRAWL_BASE_URL || "http://localhost:8191",
  apiKey: process.env.TRAWL_API_KEY || undefined,
  timeoutMs: 70_000,
})
```

The current self-hosted API does not verify a general API key. `apiKey` sends a
bearer header for a gateway that implements authentication. Keep it on the backend.

## 1. Fetch protected HTML

```ts
const page = await trawl.scrape({
  url: "https://nopecha.com/demo/cloudflare",
  maxTimeout: 60_000,
})

console.log({ status: page.statusCode, tier: page.tier, duration: page.totalMs })
// page.html contains the returned page; inspect statusCode before treating it as useful content.
```

The SDK calls the configured TRAWL server. CAPTCHA solving, retries within solving,
proxy routing and session caching remain server responsibilities. SDK HTTP requests
are not automatically retried.

## 2. Prepare article content for an AI application

```ts
import { writeFile } from "node:fs/promises"

const article = await trawl.read({
  url: "https://news.example/article",
  format: "markdown",
  maxCharacters: 30_000,
})

await writeFile("/tmp/article.md", article.text)
await writeFile("/tmp/document.jsonl", `${JSON.stringify({
  source: article.url,
  title: article.title,
  text: article.text,
  truncated: article.truncated,
  retrievedAt: new Date().toISOString(),
})}\n`)
```

This prepares text with provenance for your summarizer or indexing pipeline.
Chunking, embeddings and LLM calls are application steps; scraped content should
be treated as source material, not instructions for the agent.

## 3. Extract a product catalog

```ts
const catalog = await trawl.extract({
  url: "https://shop.example/products",
  itemSelector: ".product-card",
  fields: {
    name: { selector: "h2" },
    price: { selector: ".price" },
    link: { selector: "a", attribute: "href" },
  },
  maxItems: 100,
})

const products = catalog.items.map(item => ({
  ...item,
  link: item.link ? new URL(item.link, catalog.url).href : null,
}))
console.log(products, catalog.matched, catalog.truncated)
```

Values are strings or `null`. Parsing prices and currencies is site-specific.
`maxItems` is limited to 100; pagination is explicit application logic.

## 4. Extract JavaScript-rendered job listings

```ts
const jobs = await trawl.extract({
  url: "https://careers.example/jobs",
  render: true,
  contentWaitForSelector: "[data-job]",
  itemSelector: "[data-job]",
  fields: {
    title: { selector: "h2" },
    location: { selector: ".location" },
    link: { selector: "a", attribute: "href" },
  },
})

console.log(jobs.items)
```

## 5. Preserve an authorized browser session

```ts
const session = await trawl.sessions.create({ keepPage: true })
try {
  await session.scrape({ url: "https://portal.example/dashboard" })
  const state = await session.eval(`({
    title: document.title,
    links: document.querySelectorAll("a").length
  })`)
  console.log(state)

  const report = await trawl.read({
    url: "https://portal.example/report",
    sessionId: session.id,
    format: "text",
  })
  console.log(report.title)
} finally {
  await session.close()
}
```

Supply your authorized cookies through `session.scrape({ cookies: [...] })` when
needed. The session preserves browser state; it does not provide account access.
Operations in one session are sequential. `eval` reads the retained page without
navigation, while `read`/`extract` with `sessionId` navigate the supplied URL.

## 6. Capture JSON responses loaded by a page

```ts
const page = await trawl.scrape({
  url: "https://shop.example/products",
  skipHttp: true,
  captureResponses: ["/api/products"],
  settleTimeout: 5_000,
})

const response = page.capturedResponses?.find(entry =>
  entry.url.includes("/api/products") && !entry.error && !entry.truncated &&
  !entry.base64Encoded && entry.body !== null,
)
if (!response || response.body === null) throw new Error("No complete matching response captured")
const data: unknown = JSON.parse(response.body)
console.log(data)
```

Validate the parsed JSON against the target API's schema before relying on it.

## 7. Save a screenshot

```ts
import { writeFile } from "node:fs/promises"

const page = await trawl.screenshot({
  url: "https://shop.example/product",
  screenshotSelector: ".product-detail",
  screenshotWaitForSelector: ".product-detail",
})
await writeFile("/tmp/product.jpg", Buffer.from(page.screenshot, "base64"))
```

Use `screenshotFullPage: true` for a full-page capture; do not combine it with
`screenshotSelector`. Screenshot dimensions and bytes remain bounded by the server.

## 8. Diagnose a problematic page

```ts
const page = await trawl.inspect({ url: "https://app.example/catalog" })
console.table(page.timings)
console.table(page.consoleLogs.filter(entry => entry.level === "SEVERE"))
console.table(page.networkLogs.map(entry => ({
  type: entry.entryType,
  duration: entry.duration,
  bytes: entry.transferSize,
})))
```

Native diagnostics may contain page data or sensitive URLs; choose what to retain.

## 9. Use a proxy and target headers

```ts
const page = await trawl.scrape({
  url: "https://shop.example/catalog",
  proxy: process.env.TRAWL_PROXY_URL,
  headers: { "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8" },
})
```

These headers go to the target website. Constructor `headers` and `apiKey` go to
the TRAWL API. For a persistent session, configure its proxy at creation.

## 10. Submit a target POST request

```ts
const page = await trawl.scrape({
  url: "https://portal.example/search",
  method: "POST",
  body: { query: "developer", page: 1 },
})
```

The request is forwarded through the scraping engine. Check the target's supported
methods and response format; challenge handling does not make arbitrary APIs exist.
Objects and arrays are serialized by the SDK, with a default target JSON
Content-Type. Existing string bodies and explicitly supplied content types are preserved.

## 11. Limit concurrent work

```ts
const urls = ["https://docs.example/a", "https://docs.example/b", "https://docs.example/c"]
const results: PromiseSettledResult<Awaited<ReturnType<typeof trawl.read>>>[] = []
for (let offset = 0; offset < urls.length; offset += 2) {
  results.push(...await Promise.allSettled(
    urls.slice(offset, offset + 2).map(url => trawl.read({ url })),
  ))
}
console.log(results.map(result => result.status))
```

This application helper allows at most two simultaneous calls. Tune that number
to server capacity. Do not run concurrent operations on the same explicit session.

## 12. Check for content changes

```ts
import { createHash } from "node:crypto"

const previousHash = process.env.PREVIOUS_CONTENT_HASH
const article = await trawl.read({ url: "https://docs.example/changelog", format: "text" })
if (article.truncated) throw new Error("The selected content exceeded the read limit")
const hash = createHash("sha256").update(article.text).digest("hex")
if (previousHash && previousHash !== hash) console.log("Content changed")
console.log({ hash })
```

Store the hash in your database and schedule the job. This detects changes in the
extracted text; it does not prove that a target or CDN returned its newest copy.

## 13. Handle errors and cancellation

```ts
const controller = new AbortController()
try {
  const page = await trawl.scrape(
    { url: "https://app.example", maxTimeout: 20_000, blockedEvidence: true },
    { timeoutMs: 25_000, signal: controller.signal },
  )
  console.log(page.statusCode)
} catch (error) {
  if (!(error instanceof TrawlError)) throw error
  console.error({ kind: error.kind, status: error.status, retryAfter: error.retryAfter })
}
// Call controller.abort() from the job's cancellation handler.
```

`maxTimeout` bounds scraping on the server, `timeoutMs` bounds the client request,
and the signal lets your job cancel the connection. A client abort does not
guarantee immediate server cancellation. A successfully fetched target 404 is in
`page.statusCode`; an API failure throws `TrawlError` instead.

## Further application ideas

- Import an authorized partner portal into an internal database.
- Collect public job postings and deduplicate records by resolved URL.
- Build a documentation search index with a source URL on each record.
- Compare product availability and notify your application's users of changes.
- Save screenshots alongside scraped records for manual verification.
- Build an agent tool that returns source content with bounded output.
- Archive source HTML or opt-in MHTML when a read result alone is insufficient.
