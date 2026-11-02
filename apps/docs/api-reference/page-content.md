---
title: Read and Extract
description: Read page content as Markdown or text and extract bounded records with CSS selectors.
---

# Read and extract

These native endpoints use the same scraper, sessions, proxy routing and error
responses as `/scrape`. Content processing is shared with the MCP `read` and
`extract` tools. They are additions under Unreleased and are not present in older
server releases.

## POST /read

```json
{
  "url": "https://example.com/article",
  "format": "markdown",
  "maxCharacters": 20000
}
```

Readability extracts the main article from HTML, then returns Markdown or text.
Non-HTML responses use the scraper's decoded text. The default format is
`markdown`; `maxCharacters` defaults to 50,000 and accepts integers from 1 to
100,000. `truncated` indicates that the text exceeded the requested limit.

The response contains `url`, `statusCode`, `tier`, `contentType`, `totalMs`,
`title`, `text`, `format`, `characters` and `truncated`. Article metadata may also
include `byline`, `excerpt`, `siteName` and `language`. The title is separate from
the returned article text and may not appear inside it.

## POST /extract

```json
{
  "url": "https://example.com/articles",
  "itemSelector": ".card",
  "fields": {
    "title": { "selector": "h2" },
    "link": { "selector": "a", "attribute": "href" }
  },
  "maxItems": 25,
  "render": true,
  "contentWaitForSelector": ".card"
}
```

`fields` must define 1-20 named fields. Names start with a letter and contain up to
64 letters, digits or underscores. Each field has a CSS `selector`, relative to
the matched item, and an optional `attribute`. Without an attribute, its trimmed
text content is returned. Missing elements or attributes produce `null`.
Attributes are returned verbatim, including relative URLs.

Omit `itemSelector` to extract one document record. `maxItems` defaults to 25 and
accepts integers from 1 to 100. Selectors are capped at 500 characters, attribute
names at 64, and each returned value at 2,000. Extraction rejects HTML over
2,000,000 characters and bounds the serialized items to 100,000 characters.

The response contains page metadata (`url`, `statusCode`, `tier`, `contentType`,
`totalMs`), an `items` array, `matched` (total matching items), and `truncated`
(records were omitted because of item or output limits). Value trimming to 2,000
characters does not set `truncated`.

Set `render: true` for JavaScript content. `contentWaitForSelector` also enables a
browser attempt; either option rejects `maxTier: 1`. Native `waitForSelector`
retains its `/scrape` meaning for response capture; it is not the MCP extraction
alias for `contentWaitForSelector`.

## Scrape options and sessions

Both endpoints accept [native scrape options](/api-reference/native-api), including
headers, cookies, request method/body, proxy, timeouts and `sessionId`. They return
content and metadata, without the raw scrape result. Use `/scrape` when you need
HTML, cookies, screenshots or captured responses in the result. `totalMs` reports
the scraper's duration; it does not include content conversion time.

For a retained session, pass its ID in the body. Session expiry, serialization and
busy errors follow the [browser session](/api-reference/browser-sessions) rules.
The URL and routing policy match native `/scrape`; MCP retains its separate public
URL restrictions.

Invalid content options return 400 before scraping. Invalid CSS discovered during
extraction also returns 400; fetching the page does not turn a failed extraction
into a successful request. Blocked outcomes preserve the native error timings and
requested blocked evidence. There are no automatic retries.
