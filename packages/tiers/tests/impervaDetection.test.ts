import { afterAll, describe, expect, test } from "bun:test"
import { scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { detectChallengeType, hasImpervaChallenge, isBlocked, needsJs } from "../src/utils/detect"

const docs = `<html><head><title>Tiered execution | TRAWL</title></head><body><article>
<h2>Imperva/Incapsula challenges</h2><p>Imperva's <code>reese84</code> and <code>___utmvc</code> cookies
are produced by JavaScript. The identifiers visid_incap_, incap_ses_ and nlbi_ identify cookies.</p>
<pre>&lt;iframe src="/_Incapsula_Resource?test=1"&gt;&lt;/iframe&gt;</pre>
<p>Reports include an Incapsula incident ID.</p></article></body></html>`
const iframeWall =
  '<html><body><iframe src="/_Incapsula_Resource?SWUDNSAI=1">Incapsula incident ID: 123456-789</iframe></body></html>'
const scriptWall = '<html><body><script src="/_Incapsula_Resource?challenge=1"></script></body></html>'
const sensorWall =
  '<html><body><script>document.cookie = "___utmvc=" + token; location.reload();</script></body></html>'
const headers = { "X-Iinfo": "test-routing-info", "X-CDN": "Incapsula" }

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const wall = new URL(req.url).pathname === "/wall"
    return new Response(wall ? iframeWall : docs, { headers: { "content-type": "text/html", ...headers } })
  },
})
afterAll(() => server.stop(true))

describe("Imperva challenge detection", () => {
  test.each([
    docs,
    "reese84",
    "___utmvc",
    "Incapsula incident ID: 123",
    '{"cookie":"reese84"}',

    "<p>reese84</p>",
    "<p>visid_incap_ incap_ses_ nlbi_ ___utmvc</p>",
    "<p>Incapsula incident ID</p>",
    "<html><head><title>Imperva documentation</title></head><body>Incapsula incident ID: 123456-789</body></html>",
    '<html><body><script>const example = "reese84";</script>Article</body></html>',
    '<html><body><script type="application/json">{"reese84":{}}</script></body></html>',
    `<html><body><iframe src="javascript:alert('/_Incapsula_Resource')"></iframe>Article</body></html>`,
    `<html><body>${"Article content. ".repeat(100)}<script>document.cookie="reese84="+token;</script></body></html>`,
    '<html><body><!-- <iframe src="/_Incapsula_Resource?test=1"></iframe> -->Article</body></html>',
    '<html><body><template><iframe src="/_Incapsula_Resource?test=1"></iframe></template>Article</body></html>',
    '<html><body><noscript><iframe src="/_Incapsula_Resource?test=1"></iframe></noscript>Article</body></html>',
    '<html><body><script type="application/json">{"cookie":"reese84"}</script>Article</body></html>',
    '<html><body><p>Article</p><a href="/_Incapsula_Resource?example=1">Example</a></body></html>',
    `<html><body>${"Article content. ".repeat(100)}<script src="/_Incapsula_Resource?SWJIYLWA=1"></script></body></html>`,
  ])("does not classify ordinary content as a challenge: %s", (html) => {
    expect(hasImpervaChallenge(html)).toBeFalse()
    expect(detectChallengeType(html)).toBe("none")
    expect(isBlocked(200, html)).toBeFalse()
    expect(needsJs(html, {})).toBeFalse()
  })

  test("does not treat CDN identity headers as proof of a challenge", () => {
    expect(hasImpervaChallenge(docs, headers)).toBeFalse()
    expect(detectChallengeType(docs, headers, 200)).toBe("none")
    expect(needsJs(docs, headers)).toBeFalse()
    expect(detectChallengeType("", headers, 200)).toBe("none")
  })

  test.each([
    iframeWall,
    scriptWall,
    `<html><head><title>Security check</title></head><body><p>${"Please complete verification to access this site. ".repeat(20)}</p><script src="/_Incapsula_Resource?challenge=1"></script></body></html>`,
    "<html><head><title>Request unsuccessful</title></head><body>Incapsula incident ID: 123456-789</body></html>",
    "<html><body><script TYPE=text/javascript SRC=/_Incapsula_Resource?test=1></script></body></html>",
    '<html><body><iframe src="/_Incapsula_Resource?x=1&amp;y=2"></iframe></body></html>',
    '<html><body><script type="module">document.cookie="reese84="+token;</script></body></html>',
    sensorWall,
    '<script>document.cookie="___utmvc="+token;</script>',

    "<html><body><script>window.reese84 = {challenge: true};</script></body></html>",
    "<html><body><IFRAME SRC=https://example.test/_INCAPSULA_RESOURCE?x=1></IFRAME></body></html>",
    `<html><head><script>${"var x=1;".repeat(1000)};document.cookie="___utmvc="+token;</script></head><body></body></html>`,
  ])("retains executable challenge detection: %s", (html) => {
    expect(hasImpervaChallenge(html)).toBeTrue()
    expect(detectChallengeType(html)).toBe("imperva")
    expect(isBlocked(200, html)).toBeTrue()
    expect(needsJs(html, {})).toBeTrue()
  })

  test.each([403, 429, 503])("routes an Imperva error response with status %i", (status) => {
    expect(detectChallengeType("<html><body>Access denied</body></html>", headers, status)).toBe("imperva")
  })

  test("fetches documentation through Tier 1 without acquiring a browser", async () => {
    const result = await scrape(
      { url: `${server.url}docs`, maxTier: 1 },
      {
        acquireBrowser: async () => {
          throw new Error("Browser must not be acquired")
        },
        releaseBrowser: () => {},
        loadSession: async () => undefined,
        saveSession: async () => {},
        invalidateSession: async () => {},
      },
    )
    expect(result.tier).toBe(1)
    expect(result.statusCode).toBe(200)
    expect(result.html).toBe(docs)
    expect(result.timings).toHaveLength(1)
    expect(result.timings[0]?.status).toBe("success")
  })

  test("does not return an HTTP 200 iframe wall as successful content", async () => {
    const result = await runTier1(`${server.url}wall`)
    expect(result.status).not.toBe("success")
    expect(result.statusCode).toBe(200)
  })
})
