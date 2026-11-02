import { RequestValidationError } from "@trawl/tiers"
import type {
  ExtractRequest,
  ExtractResponse,
  ReadRequest,
  ReadResponse,
  ScrapeRequest,
  ScrapeResult,
} from "@trawl/types"
import * as z from "zod/v4"
import { extractPage, READ_DEFAULT_MAX_CHARACTERS, READ_MAX_CHARACTERS, readPage } from "."

export const readOptionsShape = {
  format: z.enum(["markdown", "text"]).optional().describe("Output format; defaults to markdown"),
  maxCharacters: z
    .number()
    .int()
    .min(1)
    .max(READ_MAX_CHARACTERS)
    .optional()
    .describe(`Maximum returned characters; defaults to ${READ_DEFAULT_MAX_CHARACTERS}`),
}
export const extractionOptionsShape = {
  itemSelector: z.string().min(1).max(500).optional().describe("CSS selector matching repeated items"),
  fields: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
      z.strictObject({
        selector: z.string().min(1).max(500).describe("CSS selector relative to each item"),
        attribute: z.string().min(1).max(64).optional().describe("HTML attribute to return; defaults to text content"),
      }),
    )
    .refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 20, {
      message: "Provide 1 to 20 fields",
    }),
  maxItems: z.number().int().min(1).max(100).optional().describe("Maximum records; defaults to 25"),
}
const readSchema = z.object(readOptionsShape)
const extractSchema = z.object({ ...extractionOptionsShape, render: z.boolean().optional() })

export function prepareExtractionRequest({ render, ...input }: ScrapeRequest & { render?: boolean }): ScrapeRequest {
  if (!(render || input.contentWaitForSelector)) return input
  if (input.maxTier === 1) throw new RequestValidationError("Browser rendering requires maxTier 2 or higher", 400)
  return { ...input, skipHttp: true }
}

export function preparePageOperation(
  operation: "read" | "extract",
  input: ScrapeRequest,
): {
  request: ScrapeRequest
  format: (result: ScrapeResult) => ReadResponse | ExtractResponse
} {
  const options = (operation === "read" ? readSchema : extractSchema).safeParse(input)
  if (!options.success) {
    const issue = options.error.issues[0]
    throw new RequestValidationError(`${issue.path.join(".") || "options"}: ${issue.message}`, 400)
  }
  if (operation === "read") {
    const { format, maxCharacters, ...request } = input as ReadRequest
    return { request, format: (result) => readPage(result, { format, maxCharacters }) }
  }
  const { itemSelector, fields, maxItems, ...request } = input as ExtractRequest
  return {
    request: prepareExtractionRequest(request),
    format: (result) => extractPage(result, { itemSelector, fields, maxItems }),
  }
}
