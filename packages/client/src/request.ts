import type { ScrapeRequest as NativeScrapeRequest } from "../../types/src/api"
import type { ScrapeRequest } from "./types"

export function prepareScrapeRequest(input: ScrapeRequest): NativeScrapeRequest {
  const body = input.body
  if (body === undefined || typeof body === "string") return { ...input, body }
  if (body === null || typeof body !== "object")
    throw new TypeError("Target body must be a string, plain object or array")
  const prototype = Object.getPrototypeOf(body)
  if (!Array.isArray(body) && prototype !== null && Object.getPrototypeOf(prototype) !== null)
    throw new TypeError("Target body must be a string, plain object or array")

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(body)
  } catch {
    throw new TypeError("Target body must be JSON-serializable")
  }
  if (serialized === undefined) throw new TypeError("Target body must be JSON-serializable")
  const headers = input.headers ?? {}
  const hasContentType = Object.keys(headers).some((name) => name.trim().toLowerCase() === "content-type")
  return {
    ...input,
    body: serialized,
    headers: hasContentType ? { ...headers } : { ...headers, "Content-Type": "application/json" },
  }
}
