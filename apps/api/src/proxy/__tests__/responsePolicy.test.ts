import { describe, expect, test } from "bun:test"
import type { BlockedEvidence, ScrapeResult } from "@trawl/types"
import { serializeResponseHeaders } from "../httpResponse"
import { responseFromBlockedEvidence, responseFromScrapeResult } from "../responsePolicy"

function result(overrides: Partial<ScrapeResult>): ScrapeResult {
  return {
    url: "https://example.test/",
    html: "",
    cookies: [],
    userAgent: "test",
    statusCode: 200,
    tier: 3,
    sessionCached: false,
    timings: [],
    totalMs: 1,
    ...overrides,
  }
}

describe("responseFromScrapeResult", () => {
  test("returns rendered HTML after a browser tier instead of the raw challenge response", () => {
    const response = responseFromScrapeResult(
      result({
        html: "<html><title>Real page</title></html>",
        body: Buffer.from("<html><title>Just a moment...</title></html>"),
        contentType: "text/html; charset=utf-8",
        responseHeaders: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "br",
          "content-length": "999",
        },
      }),
    )

    expect(response.body.toString()).toContain("Real page")
    expect(response.body.toString()).not.toContain("Just a moment")
    expect(response.headers["content-encoding"]).toBeUndefined()
    expect(response.headers["content-length"]).toBeUndefined()
  })

  test.each([2, 3, 4] as const)("strips stale representation headers from decoded Tier %i bodies", (tier) => {
    const decoded = Buffer.from('{"ok":true}')
    const response = responseFromScrapeResult(
      result({
        tier,
        body: decoded,
        contentType: "application/json",
        responseHeaders: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "31",
          "content-md5": "stale-digest",
          "content-range": "bytes 0-30/31",
          "accept-ranges": "bytes",
          etag: '"compressed-validator"',
          "transfer-encoding": "chunked",
          "cache-control": "private",
        },
      }),
    )

    expect(response.body).toEqual(decoded)
    expect(response.headers).toEqual({
      "content-type": "application/json",
      "cache-control": "private",
    })
  })

  test("preserves representation headers and raw bytes from Tier 1", () => {
    const bytes = Uint8Array.from([0, 255, 1, 2, 3])
    const response = responseFromScrapeResult(
      result({
        tier: 1,
        html: "",
        body: bytes,
        contentType: "application/octet-stream",
        responseHeaders: {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "content-range": "bytes 0-4/100",
          "accept-ranges": "bytes",
          etag: '"raw-validator"',
        },
      }),
    )

    expect([...response.body]).toEqual([...bytes])
    expect(response.headers["content-encoding"]).toBe("gzip")
    expect(response.headers["content-range"]).toBe("bytes 0-4/100")
    expect(response.headers["accept-ranges"]).toBe("bytes")
    expect(response.headers.etag).toBe('"raw-validator"')
  })

  test.each([2, 3, 4] as const)("labels rendered Tier %i HTML as UTF-8", (tier) => {
    const html = "<html><body>Рик и Морти / Příliš žluťoučký / 日本語</body></html>"
    const response = responseFromScrapeResult(
      result({
        tier,
        html,
        body: Buffer.from("upstream challenge"),
        contentType: "text/html; charset=windows-1251",
        responseHeaders: {
          "content-type": "text/html; charset=windows-1251",
          "content-encoding": "gzip",
          "content-length": "999",
          "set-cookie": "session=value",
          "cache-control": "private",
        },
      }),
    )
    expect(response.contentType).toBe("text/html; charset=utf-8")
    expect(response.headers["content-type"]).toBe(response.contentType)
    const charset = response.contentType.match(/charset=([^;]+)/)?.[1]
    expect(new TextDecoder(charset).decode(response.body)).toBe(html)
    expect(response.headers["set-cookie"]).toBe("session=value")
    expect(response.headers["cache-control"]).toBe("private")
    const head = serializeResponseHeaders(200, response.headers, response.contentType, {
      bodyLength: response.body.length,
    })
    expect(head.toLowerCase()).toContain("content-type: text/html; charset=utf-8\r\n")
    expect(head).toContain(`Content-Length: ${Buffer.byteLength(html)}\r\n`)
    expect(head.toLowerCase()).not.toContain("content-encoding:")
  })

  test.each([
    ["text/html", "text/html; charset=utf-8"],
    [
      'text/html; profile="example;charset=legacy"; charset=windows-1251',
      'text/html; profile="example;charset=legacy"; charset=utf-8',
    ],
    ['text/html; charset=windows-1251; charset="iso-8859-1"', "text/html; charset=utf-8"],
    ['application/xhtml+xml; charset="ISO-8859-1"', "application/xhtml+xml; charset=utf-8"],
    ["text/html; profile=example; CHARSET = windows-1251", "text/html; profile=example; charset=utf-8"],
  ])("normalizes the charset of rendered %s", (contentType, expected) => {
    const response = responseFromScrapeResult(result({ html: "<html>é</html>", contentType }))
    expect(response.contentType).toBe(expected)
    expect(response.headers["content-type"]).toBe(expected)
  })

  test("uses the header charset when the browser result has no contentType", () => {
    const response = responseFromScrapeResult(
      result({ html: "<html>Рик</html>", responseHeaders: { "content-type": "text/html; charset=windows-1251" } }),
    )
    expect(response.contentType).toBe("text/html; charset=utf-8")
    expect(response.body.toString("utf8")).toBe("<html>Рик</html>")
  })

  test("preserves Tier 1 legacy HTML bytes even when decoded HTML is available", () => {
    const bytes = Buffer.from([0xd0, 0xe8, 0xea])
    const contentType = "text/html; charset=windows-1251"
    const response = responseFromScrapeResult(
      result({
        tier: 1,
        html: "Рик",
        body: bytes,
        contentType,
        responseHeaders: { "content-type": contentType, etag: '"original"' },
      }),
    )
    expect(response.body).toEqual(bytes)
    expect(response.contentType).toBe(contentType)
    expect(response.headers.etag).toBe('"original"')
    expect(new TextDecoder("windows-1251").decode(response.body)).toBe("Рик")
  })

  test("labels an HTML-only Tier 1 fallback as UTF-8", () => {
    const response = responseFromScrapeResult(
      result({ tier: 1, html: "Рик", contentType: "text/html; charset=windows-1251" }),
    )
    expect(response.contentType).toBe("text/html; charset=utf-8")
    expect(response.body.toString("utf8")).toBe("Рик")
  })

  test("preserves decoded non-HTML browser bytes and their charset", () => {
    const bytes = Buffer.from([0xd0, 0xe8, 0xea])
    const contentType = "text/plain; charset=windows-1251"
    const response = responseFromScrapeResult(result({ html: "Рик", body: bytes, contentType }))
    expect(response.body).toEqual(bytes)
    expect(response.contentType).toBe(contentType)
  })

  test("serializes decoded browser content with its actual length and no stale encoding", () => {
    const response = responseFromScrapeResult(
      result({
        tier: 3,
        body: Buffer.from('{"ok":true}'),
        contentType: "application/json",
        responseHeaders: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "31",
        },
      }),
    )
    const head = serializeResponseHeaders(200, response.headers, response.contentType, {
      bodyLength: response.body.length,
    })

    expect(head.toLowerCase()).not.toContain("content-encoding:")
    expect(head).toContain(`Content-Length: ${response.body.length}\r\n`)
  })
})

describe("responseFromBlockedEvidence", () => {
  const baseEvidence: BlockedEvidence = {
    tier: 3,
    status: "blocked",
    url: "https://duckduckgo.com/",
    html: '<html><body><form id="challenge-form"></form></body></html>',
    statusCode: 202,
    reason: "duckduckgo-persistent",
  }

  test("preserves upstream statusCode and challenge HTML", () => {
    const response = responseFromBlockedEvidence(baseEvidence)
    expect(response.statusCode).toBe(202)
    expect(response.contentType).toBe("text/html; charset=utf-8")
    expect(response.body.toString("utf8")).toBe(baseEvidence.html)
    expect(response.headers).toEqual({
      "content-type": "text/html; charset=utf-8",
      "x-trawl-status": "blocked",
      "x-trawl-reason": "duckduckgo-persistent",
    })
  })

  test("falls back to 403 when statusCode cannot carry the challenge body", () => {
    for (const statusCode of [undefined, 202.5, 204, 205, 304, 601]) {
      const response = responseFromBlockedEvidence({ ...baseEvidence, statusCode })
      expect(response.statusCode).toBe(403)
    }
  })

  test("returns an error status for unresolved Anubis at HTTP 200", () => {
    expect(responseFromBlockedEvidence({ ...baseEvidence, reason: "anubis-blocked", statusCode: 200 }).statusCode).toBe(
      403,
    )
    expect(
      responseFromBlockedEvidence({
        ...baseEvidence,
        reason: "anubis-challenge-timeout",
        status: "timeout",
        statusCode: 200,
      }).statusCode,
    ).toBe(504)
    expect(responseFromBlockedEvidence({ ...baseEvidence, reason: "anubis-blocked", statusCode: 429 }).statusCode).toBe(
      429,
    )
  })

  test("omits x-trawl-reason when reason is undefined", () => {
    const response = responseFromBlockedEvidence({
      ...baseEvidence,
      reason: undefined,
    })
    expect(response.headers["x-trawl-reason"]).toBeUndefined()
    expect(response.headers["x-trawl-status"]).toBe("blocked")
  })
})
