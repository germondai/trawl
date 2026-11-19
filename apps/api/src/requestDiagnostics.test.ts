import { expect, test } from "bun:test"
import type { ScrapeResult } from "@trawl/types"
import { MetricsStore } from "./metrics"
import { requestDiagnostics } from "./requestDiagnostics"

test("retained diagnostics count UTF-8 body bytes and omit private headers, URL and cookies", () => {
  const result = {
    url: "https://example.com",
    cookies: [],
    userAgent: "fixture",
    statusCode: 200,
    tier: 3,
    sessionCached: false,
    totalMs: 42,
    html: "čau",
    contentType: "application/json; charset=utf-8",
    responseHeaders: { "set-cookie": "secret" },
    captchasSolved: ["turnstile:2captcha"],
    timings: [{ tier: 3, status: "success", durationMs: 42 }],
  } as ScrapeResult
  const diagnostics = requestDiagnostics(
    { url: "https://private.example/path?token=secret", body: "ž", headers: { authorization: "secret" } },
    result,
  )
  expect(diagnostics).toEqual({
    requestBodyBytes: 2,
    responseBytes: 4,
    contentType: "application/json",
    responseKind: "json",
    challenges: ["turnstile"],
    timings: [{ tier: 3, status: "success", durationMs: 42 }],
  })
  expect(JSON.stringify(diagnostics)).not.toContain("secret")
  const store = new MetricsStore(true)
  try {
    store.record({
      requestId: "diagnostics",
      method: "POST",
      source: "native",
      url: "https://example.com",
      statusCode: 200,
      tier: 3,
      durationMs: 50,
      diagnostics,
    })
    expect(store.request("diagnostics")?.diagnostics).toEqual(diagnostics)
    expect(store.history(1).entries[0]?.diagnostics).toEqual(diagnostics)
  } finally {
    store.close()
  }
})

test("distinguishes attachments and streams and bounds retained attempts", () => {
  const result = {
    url: "https://example.com",
    cookies: [],
    userAgent: "fixture",
    statusCode: 200,
    tier: 1,
    sessionCached: false,
    totalMs: 20,
    html: "",
    contentType: "text/event-stream",
    timings: Array.from({ length: 20 }, () => ({ tier: 1, status: "success", durationMs: 1 })),
  } as ScrapeResult
  expect(requestDiagnostics({ url: "https://example.com" }, result).responseKind).toBe("stream")
  result.responseHeaders = { "content-disposition": "attachment; filename=private.pdf" }
  const value = requestDiagnostics({ url: "https://example.com" }, result)
  expect(value.responseKind).toBe("file")
  expect(value.timings).toHaveLength(8)
  expect(JSON.stringify(value)).not.toContain("private.pdf")
})

test("failed blocked challenges remain visible without retaining the raw reason", () => {
  const value = requestDiagnostics({ url: "https://example.com" }, undefined, [
    { tier: 3, status: "blocked", durationMs: 12, reason: "Cloudflare challenge at private-url" },
  ])
  expect(value.challenges).toEqual(["cloudflare"])
  expect(JSON.stringify(value)).not.toContain("private-url")
})
