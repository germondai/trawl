import { describe, expect, test } from "bun:test"
import { RequestValidationError } from "@trawl/tiers"
import { requestUrl, validateFlareSolverrRequest, validateScrapeRequest } from "./validation"

const invalidBodies: unknown[] = [undefined, null, [], "text", 42, true]

describe("API request validation", () => {
  for (const body of invalidBodies) {
    test(`rejects non-object body ${JSON.stringify(body)}`, () => {
      expect(() => validateFlareSolverrRequest(body)).toThrow(
        new RequestValidationError("Request body must be a JSON object", 400),
      )
      expect(() => validateScrapeRequest(body)).toThrow(
        new RequestValidationError("Request body must be a JSON object", 400),
      )
    })
  }

  for (const url of [undefined, null, "", "   ", 42]) {
    test(`rejects invalid url ${JSON.stringify(url)}`, () => {
      expect(() => validateFlareSolverrRequest({ url })).toThrow(
        new RequestValidationError("url must be a non-empty string", 400),
      )
      expect(() => validateScrapeRequest({ url })).toThrow(
        new RequestValidationError("url must be a non-empty string", 400),
      )
    })
  }

  test("accepts valid request bodies for both API shapes", () => {
    expect(() => validateFlareSolverrRequest({ cmd: "request.get", url: "https://example.com" })).not.toThrow()
    expect(() => validateScrapeRequest({ method: "GET", url: "https://example.com" })).not.toThrow()
  })

  test("accepts boolean screenshot flags and rejects other values", () => {
    expect(() => validateScrapeRequest({ url: "https://example.com", screenshot: true })).not.toThrow()
    expect(() => validateScrapeRequest({ url: "https://example.com", screenshot: false })).not.toThrow()
    expect(() => validateScrapeRequest({ url: "https://example.com", screenshot: "true" })).toThrow(
      new RequestValidationError("screenshot must be a boolean", 400),
    )
  })

  test("validates element screenshot selectors and incompatible modes", () => {
    expect(() =>
      validateScrapeRequest({ url: "https://example.com", screenshot: true, screenshotSelector: ".chart" }),
    ).not.toThrow()
    for (const screenshotSelector of ["", " ", "x".repeat(501), 42]) {
      expect(() => validateScrapeRequest({ url: "https://example.com", screenshotSelector })).toThrow(
        RequestValidationError,
      )
    }
    expect(() =>
      validateScrapeRequest({
        url: "https://example.com",
        screenshot: true,
        screenshotFullPage: true,
        screenshotSelector: ".chart",
      }),
    ).toThrow(RequestValidationError)
  })

  for (const field of [
    "consoleLogs",
    "networkLogs",
    "redirectChain",
    "blockedEvidence",
    "mhtml",
    "ignoreCertificateErrors",
    "favicons",
    "followMetaRefresh",
  ] as const) {
    test(`accepts boolean ${field} flags and rejects other values`, () => {
      expect(() => validateScrapeRequest({ url: "https://example.com", [field]: true })).not.toThrow()
      expect(() => validateScrapeRequest({ url: "https://example.com", [field]: false })).not.toThrow()
      expect(() => validateScrapeRequest({ url: "https://example.com", [field]: "true" })).toThrow(
        new RequestValidationError(`${field} must be a boolean`, 400),
      )
    })
  }

  test("validates response-capture patterns", () => {
    expect(() => validateScrapeRequest({ url: "https://example.com", captureResponses: ["/api/*"] })).not.toThrow()
    for (const captureResponses of ["/api", ["ok", 3], [""], ["   "], ["x".repeat(2_001)], Array(11).fill("x")]) {
      expect(() => validateScrapeRequest({ url: "https://example.com", captureResponses })).toThrow(
        RequestValidationError,
      )
    }
  })

  test("validates response-capture settling options", () => {
    expect(() => validateScrapeRequest({ url: "https://example.com", settleTimeout: 0 })).not.toThrow()
    expect(() => validateScrapeRequest({ url: "https://example.com", waitForSelector: "#results" })).not.toThrow()
    for (const settleTimeout of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
      expect(() => validateScrapeRequest({ url: "https://example.com", settleTimeout })).toThrow(RequestValidationError)
    }
    for (const waitForSelector of ["", "   ", 42]) {
      expect(() => validateScrapeRequest({ url: "https://example.com", waitForSelector })).toThrow(
        RequestValidationError,
      )
    }
  })

  test("validates browser HTML selector waits independently of response capture", () => {
    expect(() =>
      validateScrapeRequest({ url: "https://example.com", skipHttp: true, contentWaitForSelector: ".card" }),
    ).not.toThrow()
    for (const contentWaitForSelector of ["", " ", "x".repeat(501), 42]) {
      expect(() => validateScrapeRequest({ url: "https://example.com", contentWaitForSelector })).toThrow(
        RequestValidationError,
      )
    }
  })

  test("extracts only string URLs for error envelopes", () => {
    expect(requestUrl({ url: "https://example.com" })).toBe("https://example.com")
    expect(requestUrl({ url: 42 })).toBe("")
    expect(requestUrl(null)).toBe("")
  })
})
