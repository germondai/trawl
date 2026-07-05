import { describe, expect, test } from "bun:test"
import {
  isValidMethod,
  RESERVED_HEADER_NAMES,
  RequestValidationError,
  requireContentTypeForBody,
  sanitizeHeaders,
} from "../src/sanitize"

describe("sanitizeHeaders", () => {
  test("returns undefined for undefined / empty input", () => {
    expect(sanitizeHeaders(undefined)).toBeUndefined()
    expect(sanitizeHeaders({})).toBeUndefined()
  })

  test("passes through ordinary non-reserved headers unchanged", () => {
    const out = sanitizeHeaders({
      Accept: "application/json",
      "X-Custom-Header": "ok",
      Referer: "https://example.com/a",
    })
    expect(out).toEqual({
      Accept: "application/json",
      "X-Custom-Header": "ok",
      Referer: "https://example.com/a",
    })
  })

  test("drops case-insensitive reserved headers (Host, Cookie, Authorization, ...)", () => {
    const out = sanitizeHeaders({
      host: "evil.example",
      Host: "evil.example",
      HOST: "evil.example",
      cookie: "session=secret",
      Cookie: "session=secret",
      authorization: "Bearer x",
      Authorization: "Bearer x",
      "x-forwarded-for": "1.2.3.4",
      "X-Forwarded-For": "1.2.3.4",
      "cf-connecting-ip": "1.2.3.4",
      "user-agent": "evil-ua",
      "sec-fetch-mode": "no-cors",
      Accept: "application/json",
    })
    expect(out).toEqual({ Accept: "application/json" })
  })

  test("strips NUL / CR / LF characters from header values", () => {
    const out = sanitizeHeaders({
      "X-Evil": "abc\x00def",
      "X-Multi": "a\r\nb",
      Accept: "application/json",
    })
    expect(out).toEqual({
      "X-Evil": "abcdef",
      "X-Multi": "ab",
      Accept: "application/json",
    })
  })

  test("drops empty-string values after sanitisation", () => {
    const out = sanitizeHeaders({
      "X-Empty": "\x00",
      Accept: "application/json",
    })
    expect(out).toEqual({ Accept: "application/json" })
  })

  test("preserves the set of reserved names as a frozen allowlist", () => {
    expect(RESERVED_HEADER_NAMES.has("host")).toBe(true)
    expect(RESERVED_HEADER_NAMES.has("cookie")).toBe(true)
    expect(RESERVED_HEADER_NAMES.has("authorization")).toBe(true)
    expect(RESERVED_HEADER_NAMES.has("x-forwarded-for")).toBe(true)
    expect(RESERVED_HEADER_NAMES.has("cf-connecting-ip")).toBe(true)
    expect(RESERVED_HEADER_NAMES.has("sec-ch-ua")).toBe(true)
    expect(RESERVED_HEADER_NAMES.has("not-a-reserved-name")).toBe(false)
  })
})

describe("isValidMethod", () => {
  test("accepts undefined (default = GET) and the full standard verb set", () => {
    expect(isValidMethod(undefined)).toBe(true)
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]) {
      expect(isValidMethod(m)).toBe(true)
    }
  })

  test("rejects non-standard verbs and unknown strings", () => {
    expect(isValidMethod("CONNECT")).toBe(false) // tunneling verb — intentionally excluded
    expect(isValidMethod("FOOBAR")).toBe(false)
    expect(isValidMethod("get")).toBe(false) // case-sensitive
    expect(isValidMethod("post")).toBe(false)
    expect(isValidMethod("")).toBe(false)
    expect(isValidMethod(null)).toBe(false)
    expect(isValidMethod(123)).toBe(false)
  })
})

describe("requireContentTypeForBody", () => {
  test("does nothing when there is no body", () => {
    expect(() => requireContentTypeForBody(undefined, false)).not.toThrow()
    expect(() => requireContentTypeForBody({}, false)).not.toThrow()
  })

  test("throws 400 when body present but no headers at all", () => {
    expect(() => requireContentTypeForBody(undefined, true)).toThrow(RequestValidationError)
  })

  test("throws 400 when Content-Type header is missing", () => {
    expect(() => requireContentTypeForBody({ Accept: "application/json" }, true)).toThrow(RequestValidationError)
  })

  test("accepts explicit Content-Type regardless of letter case", () => {
    expect(() => requireContentTypeForBody({ "Content-Type": "application/json" }, true)).not.toThrow()
    expect(() => requireContentTypeForBody({ "content-type": "application/json" }, true)).not.toThrow()
    expect(() => requireContentTypeForBody({ "CONTENT-TYPE": "application/x-www-form-urlencoded" }, true)).not.toThrow()
  })

  test("rejects whitespace-only Content-Type", () => {
    expect(() => requireContentTypeForBody({ "Content-Type": "   " }, true)).toThrow(RequestValidationError)
  })
})
