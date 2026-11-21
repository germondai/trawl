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

test("retains measured spans and safe reason codes without private exception text", () => {
  const diagnostics = requestDiagnostics(
    { url: "https://example.com", sessionId: "known-session" },
    undefined,
    [
      { tier: 1, status: "needs-js", durationMs: 10, reason: "javascript-shell" },
      {
        tier: 3,
        status: "error",
        durationMs: 20,
        reason: "https://user:password@private.test/secret-path?token=secret",
      },
    ],
    undefined,
    {
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [
        {
          kind: "tier",
          tier: 3,
          startedAt: "2026-01-01T00:00:00.010Z",
          durationMs: 20,
          status: "error",
          reason: "secret source code",
        },
      ],
      error: new Error("browser closed"),
    },
  )
  expect(diagnostics.sessionId).toBe("known-session")
  expect(diagnostics.timings[0]?.reason).toBe("javascript-shell")
  expect(diagnostics.timings[1]?.reason).toBeUndefined()
  expect(diagnostics.stages?.[0]?.durationMs).toBe(20)
  expect(diagnostics.cause).toBe("browser")
  for (const value of ["password", "secret-path", "source code"])
    expect(JSON.stringify(diagnostics)).not.toContain(value)
  expect(diagnostics.verification?.find((check) => check.check === "http-status")?.status).toBe("skipped")
})

test("generic access-denied is suspected and empty buffers fail content presence", () => {
  const context = { startedAt: "2026-01-01T00:00:00.000Z", stages: [] }
  const failed = requestDiagnostics(
    { url: "https://example.com" },
    undefined,
    [{ tier: 1, status: "blocked", reason: "http-403", durationMs: 2 }],
    undefined,
    { ...context, error: new Error("failed") },
  )
  expect(failed.cause).toBe("suspected-security-block")
  const empty = requestDiagnostics(
    { url: "https://example.com" },
    { html: "", body: Buffer.alloc(0), statusCode: 200, timings: [] } as unknown as import("@trawl/types").ScrapeResult,
    [],
    undefined,
    context,
  )
  expect(empty.verification?.find((check) => check.check === "response-content")?.status).toBe("failed")
})

test("a body-detected block on HTTP 200 is not labelled an HTTP error", () => {
  const context = { startedAt: "2026-01-01T00:00:00.000Z", stages: [], error: new Error("blocked") }
  const value = requestDiagnostics(
    { url: "https://example.com" },
    undefined,
    [{ tier: 1, status: "blocked", reason: "http-200", durationMs: 1 }],
    undefined,
    context,
  )
  expect(value.cause).toBe("security-block")
})
