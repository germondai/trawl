---
title: Instance Observability
description: Read-only settings, retained requests and independent live request and application-log streams.
---

# Instance Observability

Capable instances advertise optional `clientRequestIds: true` in `/capabilities`.
Native `/scrape`, `/read` and `/extract` can then accept a unique lowercase UUID v4
in `X-Trawl-Request-ID`, linking a pending run to its observation. Duplicate,
malformed or temporarily untrackable proposals are replaced by a server ID.
Always use the final response header/body as confirmation. This does not make
requests idempotent or safe to retry automatically.

These resources are part of the unreleased v2 work. Older instances may not offer them;
the desktop keeps using existing dashboard metrics where available.

## Enable access

```ini
OBSERVABILITY_ENABLED=true
METRICS_DASHBOARD_TOKEN=<random-secret-at-least-32-characters>
METRICS_DB_PATH=/data/metrics/trawl.sqlite
```

Restart the server after changing these values. Every data endpoint below requires
`Authorization: Bearer <token>`. Enabling the anonymous metrics dashboard does not
enable these resources. Native desktop-owned instances generate a private token and
enable observability on first setup unless explicitly configured otherwise.

This access is read-only. It does not provide configuration writes, a remote terminal,
Docker access or control over the host. Existing native scraping and FlareSolverr
authentication behavior is unchanged. Use HTTPS outside a trusted local network.

## Resources

| Endpoint | Response |
| --- | --- |
| `GET /capabilities` | Public feature flags, schema version and the authentication scheme for observability. Contains no settings or request data. |
| `GET /settings` | Effective engine settings with descriptions, groups and sources. Secret values are `null` with a `configured` flag. |
| `GET /requests?limit=50&before=<id>` | Completed history, active requests, the next page cursor and the current request-stream cursor. |
| `GET /requests/:id` | Retained metadata for one request. |
| `GET /requests/:id/captures` | Saved-content metadata and availability for that retained request. |
| `GET /requests/:id/captures/html` | Bounded saved response bytes, served as an attachment with a plain-text media type. |
| `GET /requests/:id/captures/screenshot` | Bounded saved JPEG attachment. |
| `GET /requests/events` | Request start, completion and failure events over SSE. |
| `GET /logs?limit=100` | Recent structured application-log entries and the log-stream cursor. |
| `GET /logs/events` | Independent application-log SSE stream. |
| `GET /browser/pages` | Currently observed operation/session main pages, with redacted origins and ownership. |
| `GET /browser/pages/:id/preview` | A bounded JPEG of that existing page. Never opens a page or navigates the target. |

`/settings` reports normalized engine values. For example, a malformed pool-size
override that falls back to one is reported as `1`, with source `normalized`.
`environment` refers to the environment received by the engine; a native launcher
may have resolved a configuration file or command-line flag into that environment.
Firefox preferences and custom transcription URLs are treated as sensitive because
they can contain credentials. Unknown environment variables are never exported.

History retains domain names, not complete target URLs, bodies, headers or cookies.
New native scrape/read/extract responses expose `requestId`; native responses also
include `X-Trawl-Request-ID`. IDs match the log and request-lifecycle entries and
remain stable across server restarts. Existing history is migrated without deleting
its rows; legacy rows receive durable IDs and can lack a recorded method.

Request pages accept a limit from 1 to 100. Pass `nextCursor` as `before` to load
older entries; new arrivals do not shift that page. An unavailable cursor returns
409 and requires reloading the first page. Missing/pruned details return 404.
The existing history retention is 30 days and approximately 50,000 completed rows.
Active snapshots contain at most 256 entries and explicitly flag an incomplete list.

## Optional saved responses

History is metadata-only by default (`HISTORY_CAPTURE_MODE=none`). Enable `html`,
`screenshot` or `both` on the instance host and restart. This requires observability
and its token. Desktop-owned instances expose the same settings; remote settings
remain read-only. Saved responses may contain private page data: files are not
redacted or encrypted, so protect the instance's data volume and token.

| Setting | Default | Limit |
| --- | --- | --- |
| `HISTORY_CAPTURE_MAX_BYTES` | 2 MiB | Per artifact, before compression; maximum 8 MiB. |
| `HISTORY_CAPTURE_STORAGE_BYTES` | 128 MiB | Captured files combined; maximum 1 GiB. |
| `HISTORY_CAPTURE_MAX_RECORDS` | 500 | Requests retaining files; maximum 5,000. |
| `HISTORY_CAPTURE_TTL_SECONDS` | 604,800 (7 days) | Maximum 30 days. |
| `HISTORY_CAPTURE_FALLBACK_HTML` | `false` | In screenshot mode, save available HTML if a usable screenshot is unavailable. |
| `HISTORY_CAPTURE_TIMEOUT_MS` | 750 ms | Best-effort screenshot budget; maximum 2 seconds. |
| `HISTORY_CAPTURE_SCREENSHOT_WIDTH` | 1,920 px | Maximum 3,840 px; viewport is clipped, never resized. |
| `HISTORY_CAPTURE_SCREENSHOT_HEIGHT` | 1,080 px | Maximum 2,160 px. |
| `HISTORY_CAPTURE_SCREENSHOT_QUALITY` | 50 | JPEG quality for new history shots, maximum 90; a bounded requested screenshot may be reused. |

Files and a separate SQLite index live in `captures/` beside `METRICS_DB_PATH`.
The directory is private to TRAWL; an unrelated existing database/directory is
rejected. HTML is compressed only when smaller. The file quota excludes the
metadata index (up to 64 MiB with its default page size) and SQLite journal files;
allow additional disk space for those. Index records are separately bounded to
50,000 and 30 days. Ordinary request history retention remains independent.

Capture uses the HTML already returned by the engine and an existing browser page
before release. It never launches a browser just to photograph an HTTP-tier success.
Streamed proxy responses remain streamed and have no stored body; buffered text
can be retained within the size/decompression limit. Busy queues and short request
budgets skip optional screenshots. At most two screenshots and four storage jobs
are in flight. Capture failure does not change the scrape response or its success.

Metadata distinguishes `pending`, `ready`, `unavailable`, `too-large`, `expired`
and `failed`. Old records have an empty capture list. Age/quota eviction removes
files and retains an availability record; background age pruning runs every minute.
Interrupted writes recover at startup. Storage initialization or maintenance errors
disable capture until restart, without disabling scraping. Captures are available
only while their corresponding request history is retained.

Downloads require the same bearer token, send `no-store` and `nosniff`, and allow
four concurrent transfers, at most 8 MiB each and 15 seconds per transfer. HTML is
served as plain text, never as an active page. The desktop verifies the recorded
size/hash, shows screenshots as images and renders a reduced readable HTML copy
in an opaque sandbox. Page scripts, CSS, forms, links and outbound resources are
removed. Its source view is escaped; large previews are limited. Choosing a preferred
preview is device-local and does not change server capture policy. Closing/hiding
the viewer releases its download and preview buffers. Opening saved content does
not navigate to or scrape the target again.

## Live updates

Fetch the corresponding snapshot first, then pass its `cursor` in the
`Last-Event-ID` header when opening that stream. Cursors belong to one stream and
one server process; request and log cursors are independent. Do not put tokens in URLs.

SSE events use `id`, `event` and JSON `data` fields:

- `ready`: the requested replay cursor is usable.
- `entry`: a request lifecycle object or structured application-log entry.
- `reset`: reload the snapshot because the server restarted or replay is unavailable.

Reconnect from the last processed event ID, deduplicate by ID, and reload on `reset`.
Request lifecycle entries also carry the durable request ID. A completion's
`persisted` flag distinguishes successful history storage from an unavailable history
write; optional monitoring failures do not change a successful scrape into a failure.

Each journal retains at most 2,048 entries and 2 MiB. Individual entries are bounded
to 16 KiB, each topic accepts at most 16 subscribers, and each server stream has a
64 KiB queue budget. Slow readers use the shared replay journal and receive a reset
if it expires. Heartbeats run every 20 seconds. Reverse proxies must permit streaming
and avoid response buffering; the server sends `X-Accel-Buffering: no`.

Application logs cover structured request/server lifecycle, cache availability and memory warnings since startup and respect
`LOG_LEVEL`. They do not mirror arbitrary console output, private page diagnostics,
container daemon logs or previous-process files. The desktop retains at most 500
rendered entries and offers the separate private process-log tail for its local instance.

The desktop uses streams only on their relevant visible pages, closes them on
instance/page changes or tray destruction, and reconnects through fresh snapshots.
Its native bridge uses header authentication, per-event limits, connect/idle deadlines
and acknowledged IPC delivery so an unread view cannot build an unbounded queue.

## Existing browser pages

Set `BROWSER_INSPECTION_ENABLED=true` together with authenticated observability and
restart the host. Inspection defaults off. The desktop Browser page lists the main
pages owned by active browser-backed requests and retained `keepPage` sessions.
It does not enumerate browser extension/internal tabs or infer current activity from
completed history. HTTP-only successes have no browser page to inspect.

Page IDs are ephemeral. Metadata links an active request ID or retained session ID,
reports its tier/browser/display mode, and exposes only the current origin. Target
paths, credentials, query strings and fragments are omitted. An operation temporarily
owns its session page; after completion that same page returns to the idle session.
Closing/expiring the page removes its observation.

Selecting a page takes a single image. Metadata changes invalidate an outdated image
without taking another one while Live preview is off. Refresh image is explicit;
Live preview opts into refresh at most once per second. It stops on view exit,
instance change or hiding. Transient busy/rate/transport errors are retried only for
live read operations, with at least a one-second delay; permanent errors pause them.
Page metadata refreshes every two seconds while the inspector is visible and can be
refreshed manually after a metadata-read failure.

Previews use the existing page without acquiring a browser, resizing its viewport,
navigating or accepting viewer-supplied page code. Browser-controlled native viewports
are clipped by Playwright itself. Each JPEG is limited to 1 MiB and 1,280 × 720 CSS
pixels, with a 350 ms capture deadline and a one-second request-budget reserve.
The server permits at most two capture starts per second globally, two in-flight
protocol operations and one per page; timed-out operations retain their slot until
the protocol settles. At most two images are cached, with reuse limited to one second. Registry capacity
is 128 pages, with an explicit truncated flag. Downloads share the bounded transfer
pool with saved artifacts. No preview images are written to disk or lifecycle streams.

A retained page is not kept alive by viewing it: the normal session lifetime still
applies. Navigations, closed pages, exhausted budgets and oversized images may make
an individual preview unavailable. Inspection is observational, not remote browser
control, a remote desktop or a guarantee that every in-flight page can be photographed.

### Visible debug sessions

On macOS/Windows hosts with an interactive graphical session, configure
`BROWSER_HEADFUL_POOL_SIZE` above zero and restart while idle. This allocates extra
browser capacity; the normal headless pool remains separate. Open headed debug session
creates a named retained session through the existing session API and selects it in
New request. Sending a request then uses that session's visible window on the **host**.
The unpublished SDK can also use `trawl.sessions.create({ headful: true, keepPage: true })`.

Desktop-created sessions have a `desktop-debug-…` ID and offer Close debug session
while idle. They remain visible/listed until closed or expired; leaving the view or
cancelling a local wait does not prove accepted creation was cancelled. Refresh the
page/session list before retrying an uncertain operation. The native bridge permits
only these named debug-session creates/closes, not arbitrary evaluation or settings
writes. Existing server session API/authentication behavior is unchanged.

On Linux the current headed pool runs behind Xvfb, a virtual display. It does not open
a window on your client computer. Use the inspector preview; remote desktop/VNC is
outside this feature. Native platform/signing verification remains required before
public v2 distribution.

## Unpublished SDK

```ts
const capabilities = await trawl.capabilities()
if (capabilities.settings) console.log(await trawl.settings())

const history = await trawl.requests.list({ limit: 50 })
const abort = new AbortController()
for await (const event of trawl.requests.events({
  cursor: history.cursor,
  signal: abort.signal,
})) {
  if (event.type === 'reset') break // Reload the snapshot before reconnecting.
  if (event.type === 'entry') console.log(event.data)
}
```

Logs use `trawl.logs.list()` and `trawl.logs.events()`. Both iterators stop their
transport when aborted or exited with `break`. They do not automatically retry;
callers decide when to reconnect. Connection and idle deadlines are separate from
the whole-response timeout used by ordinary JSON calls.

For capable instances, `trawl.requests.captures(id)` returns saved-content metadata
and `trawl.requests.artifact(id, 'html' | 'screenshot', { signal })` returns bytes.
Artifact downloads have a byte limit and a total deadline and are never retried
automatically. Check metadata before choosing a renderer; HTML is untrusted content.

`trawl.browser.list()` returns the page snapshot; `trawl.browser.preview(pageId,
{ signal })` returns JPEG bytes with a 1 MiB limit and five-second default download
deadline. These are reads of existing pages, distinct from `trawl.inspect(url)`,
which runs a new scraping operation.
