import {
  isValidMethod,
  RequestValidationError,
  requireContentTypeForBody,
  SUPPORTED_METHODS,
  sanitizeHeaders,
} from "@trawl/tiers"
import type { FlareSolverrRequest, ScrapeRequest } from "@trawl/types"

type RequestRecord = Record<string, unknown>

function requireRequestRecord(body: unknown): asserts body is RequestRecord {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RequestValidationError("Request body must be a JSON object", 400)
  }
}

function requireUrl(req: RequestRecord): void {
  if (typeof req.url !== "string" || req.url.trim().length === 0) {
    throw new RequestValidationError("url must be a non-empty string", 400)
  }
}

export function requestUrl(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ""
  const url = (body as RequestRecord).url
  return typeof url === "string" ? url : ""
}

export function validateFlareSolverrRequest(body: unknown): asserts body is FlareSolverrRequest {
  requireRequestRecord(body)
  requireUrl(body)
}

export function validateScrapeRequest(body: unknown): asserts body is ScrapeRequest {
  requireRequestRecord(body)
  requireUrl(body)
  const req = body as RequestRecord & Partial<ScrapeRequest>
  if (!isValidMethod(req.method)) {
    throw new RequestValidationError(
      `Unsupported method: ${String(req.method)} (allowed: ${SUPPORTED_METHODS.join(", ")})`,
      400,
    )
  }
  if (req.screenshot !== undefined && typeof req.screenshot !== "boolean") {
    throw new RequestValidationError("screenshot must be a boolean", 400)
  }
  if (req.screenshotFullPage !== undefined && typeof req.screenshotFullPage !== "boolean") {
    throw new RequestValidationError("screenshotFullPage must be a boolean", 400)
  }
  if (
    req.screenshotWaitForSelector !== undefined &&
    (typeof req.screenshotWaitForSelector !== "string" ||
      !req.screenshotWaitForSelector.trim() ||
      req.screenshotWaitForSelector.length > 500)
  ) {
    throw new RequestValidationError(
      "screenshotWaitForSelector must be a non-empty CSS selector of at most 500 characters",
      400,
    )
  }
  if (
    req.screenshotSelector !== undefined &&
    (typeof req.screenshotSelector !== "string" ||
      !req.screenshotSelector.trim() ||
      req.screenshotSelector.length > 500)
  ) {
    throw new RequestValidationError(
      "screenshotSelector must be a non-empty CSS selector of at most 500 characters",
      400,
    )
  }
  if (req.screenshotFullPage && req.screenshotSelector) {
    throw new RequestValidationError("screenshotFullPage cannot be combined with screenshotSelector", 400)
  }
  if (
    req.contentWaitForSelector !== undefined &&
    (typeof req.contentWaitForSelector !== "string" ||
      !req.contentWaitForSelector.trim() ||
      req.contentWaitForSelector.length > 500)
  ) {
    throw new RequestValidationError(
      "contentWaitForSelector must be a non-empty CSS selector of at most 500 characters",
      400,
    )
  }
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
    if (req[field] !== undefined && typeof req[field] !== "boolean") {
      throw new RequestValidationError(`${field} must be a boolean`, 400)
    }
  }
  if (req.captureResponses !== undefined) {
    if (!Array.isArray(req.captureResponses) || !req.captureResponses.every((pattern) => typeof pattern === "string")) {
      throw new RequestValidationError("captureResponses must be an array of strings", 400)
    }
    if (req.captureResponses.length > 10) {
      throw new RequestValidationError("captureResponses must contain at most 10 patterns", 400)
    }
    if (req.captureResponses.some((pattern) => pattern.trim().length === 0 || pattern.length > 2_000)) {
      throw new RequestValidationError("captureResponses patterns must be non-empty and at most 2000 characters", 400)
    }
  }
  if (
    req.settleTimeout !== undefined &&
    (typeof req.settleTimeout !== "number" ||
      !Number.isFinite(req.settleTimeout) ||
      !Number.isInteger(req.settleTimeout) ||
      req.settleTimeout < 0)
  ) {
    throw new RequestValidationError("settleTimeout must be a non-negative finite integer", 400)
  }
  if (
    req.waitForSelector !== undefined &&
    (typeof req.waitForSelector !== "string" || req.waitForSelector.trim() === "")
  ) {
    throw new RequestValidationError("waitForSelector must be a non-empty string", 400)
  }
  requireContentTypeForBody(sanitizeHeaders(req.headers), Boolean(req.body))
}
