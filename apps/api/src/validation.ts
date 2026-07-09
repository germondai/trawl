import {
  isValidMethod,
  RequestValidationError,
  requireContentTypeForBody,
  SUPPORTED_METHODS,
  sanitizeHeaders,
} from "@trawl/tiers"
import type { ScrapeRequest } from "@trawl/types"

export function validateScrapeRequest(req: ScrapeRequest): void {
  if (!isValidMethod(req.method)) {
    throw new RequestValidationError(
      `Unsupported method: ${String(req.method)} (allowed: ${SUPPORTED_METHODS.join(", ")})`,
      400,
    )
  }
  requireContentTypeForBody(sanitizeHeaders(req.headers), Boolean(req.body))
}
