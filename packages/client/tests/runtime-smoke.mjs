import { Trawl, TrawlError } from "@trawl/client"

function assert(value, message) {
  if (!value) throw new Error(message)
}

async function run() {
  let requests = 0
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
  try {
    await client.info()
    throw new Error("Missing API failure")
  } catch (error) {
    assert(error instanceof TrawlError && error.status === 503, "Wrong API error")
  }
  assert(requests === 11, "Unexpected request retry")
  return { requests, passed: true }
}

globalThis.__trawlClientSmoke = run()
globalThis.__trawlClientSmoke.then((result) => console.log(JSON.stringify(result)))
