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

  test("strips representation headers from decoded Tier 1 bodies", () => {
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
    expect(response.headers["content-encoding"]).toBeUndefined()
    expect(response.headers["content-range"]).toBeUndefined()
    expect(response.headers["accept-ranges"]).toBeUndefined()
    expect(response.headers.etag).toBeUndefined()
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

  test("omits x-trawl-reason when reason is undefined", () => {
    const response = responseFromBlockedEvidence({
      ...baseEvidence,
      reason: undefined,
    })
    expect(response.headers["x-trawl-reason"]).toBeUndefined()
    expect(response.headers["x-trawl-status"]).toBe("blocked")
  })
})
