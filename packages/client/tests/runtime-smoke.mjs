import { Trawl, TrawlError } from "@trawl/client"

function assert(value, message) {
  if (!value) throw new Error(message)
}

async function run() {
  let requests = 0
  const pageId = "10000000-0000-4000-8000-000000000000"
  const targetBody = { query: "owned žluťoučký", values: [1, 2] }
  const page = {
    url: "https://target.example",
    html: "Owned content",
    cookies: [],
    statusCode: 200,
    userAgent: "owned-agent",
    tier: 1,
    timings: [],
    totalMs: 1,
    sessionCached: false,
  }
  const client = new Trawl({
    baseURL: "https://api.example/prefix",
    apiKey: "owned-test-key",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      assert(request.headers.get("authorization") === "Bearer owned-test-key", "Missing API authorization")
      assert(request.redirect === "manual", "Unexpected redirect policy")
      requests++
      if (request.url.endsWith(`/browser/pages/${pageId}/preview`))
        return new Response(new Uint8Array([255, 216, 255, 217]))
      if (request.url.endsWith("/browser/pages"))
        return Response.json({
          pages: [
            {
              id: pageId,
              browserId: 1,
              display: "headless",
              state: "session-idle",
              origin: page.url,
              observedAt: "2026-11-16T10:00:00.000Z",
            },
          ],
          truncated: false,
          limits: { width: 1280, height: 720, maxBytes: 1048576, intervalMs: 1000, timeoutMs: 350 },
          headedDebug: { supported: true, configured: false, display: "host-window" },
        })
      if (request.url.endsWith("/requests/owned/captures/html")) return new Response(page.html)
      if (request.url.endsWith("/requests/owned/captures"))
        return Response.json({
          requestId: "owned",
          requestAt: "2026-11-16T10:00:00.000Z",
          mode: "html",
          artifacts: [
            {
              kind: "html",
              state: "ready",
              bytes: 13,
              storedBytes: 13,
              sha256: "a".repeat(64),
              encoding: "identity",
              contentType: "text/html",
              capturedAt: "2026-11-16T10:00:00.000Z",
            },
          ],
        })
      if (["/read", "/extract", "/scrape"].some((path) => request.url.endsWith(path))) {
        const input = await request.clone().json()
        assert(input.body === JSON.stringify(targetBody), "Wrong serialized target body")
        assert(input.headers["Content-Type"] === "application/json", "Missing target JSON Content-Type")
      }
      const metadata = { url: page.url, statusCode: 200, tier: 1, contentType: "text/html", totalMs: 1 }
      if (request.url.endsWith("/read"))
        return Response.json({
          ...metadata,
          text: "Owned",
          title: "Title",
          format: "markdown",
          characters: 5,
          truncated: false,
        })
      if (request.url.endsWith("/extract"))
        return Response.json({ ...metadata, items: [{ title: "Owned" }], matched: 1, truncated: false })
      if (request.url.endsWith("/scrape")) {
        assert(request.method === "POST", "Wrong scrape method")
        assert((await request.json()).url === page.url, "Wrong scrape body")
        return Response.json({
          ...page,
          screenshot: "aGVsbG8=",
          consoleLogs: [],
          networkLogs: [],
          redirectChain: [page.url],
        })
      }
      if (request.url.endsWith("/eval")) return Response.json({ value: "Owned title" })
      if (request.url.endsWith("/cookies")) return Response.json({ cookies: [] })
      if (request.method === "DELETE") return Response.json({ status: "ok" })
      if (request.url.endsWith("/sessions"))
        return Response.json({ id: "owned", createdAt: 1, expiresAt: 2, busy: false, keepPage: true })
      return Response.json({ error: "Owned failure" }, { status: 503 })
    },
  })
  const input = { url: page.url, method: "POST", body: targetBody }
  assert((await client.scrape(input)).html === page.html, "Wrong scrape response")
  assert((await client.read(input)).text === "Owned", "Wrong read response")
  assert(
    (await client.extract({ ...input, fields: { title: { selector: "h1" } } })).items[0].title === "Owned",
    "Wrong extract response",
  )
  assert((await client.screenshot(input)).screenshot === "aGVsbG8=", "Wrong screenshot response")
  assert((await client.inspect(input)).redirectChain[0] === page.url, "Wrong inspect response")
  const session = await client.sessions.create({ keepPage: true })
  assert((await session.scrape(input)).html === page.html, "Wrong session scrape")
  assert((await session.eval("document.title")) === "Owned title", "Wrong eval response")
  assert((await session.cookies()).length === 0, "Wrong cookies response")
  await session.close()
  assert((await client.browser.list()).pages[0].id === pageId, "Wrong observed page")
  assert((await client.browser.preview(pageId))[0] === 255, "Wrong preview bytes")
  assert((await client.requests.captures("owned")).artifacts[0].state === "ready", "Wrong capture metadata")
  assert(new TextDecoder().decode(await client.requests.artifact("owned", "html")) === page.html, "Wrong saved HTML")
  try {
    await client.info()
    throw new Error("Missing API failure")
  } catch (error) {
    assert(error instanceof TrawlError && error.status === 503, "Wrong API error")
  }
  assert(requests === 15, "Unexpected request retry")
  return { requests, passed: true }
}

globalThis.__trawlClientSmoke = run()
globalThis.__trawlClientSmoke.then((result) => console.log(JSON.stringify(result)))
