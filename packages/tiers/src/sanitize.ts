export const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "host",
  "cookie",
  "authorization",
  "proxy-authorization",
  "user-agent",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-worker",
  "cf-cache-status",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
])

export function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim()
    if (!name || RESERVED_HEADER_NAMES.has(name.toLowerCase())) continue
    const value = String(rawValue ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL/CR/LF are exactly what we want to strip from header values
      .replace(/[\x00\r\n]/g, "")
      .trim()
    if (value) out[name] = value
  }
  return Object.keys(out).length ? out : undefined
}

export const SUPPORTED_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  // RFC 9341 — safe verb that carries the query in the request body.
  "QUERY",
] as const

export type SupportedMethod = (typeof SUPPORTED_METHODS)[number]

const SUPPORTED_METHOD_SET: ReadonlySet<string> = new Set(SUPPORTED_METHODS)

export function isValidMethod(method: unknown): method is SupportedMethod {
  if (method === undefined) return true
  return typeof method === "string" && SUPPORTED_METHOD_SET.has(method)
}

export class RequestValidationError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode: number) {
    super(message)
    this.name = "RequestValidationError"
    this.statusCode = statusCode
  }
}

export function requireContentTypeForBody(headers: Record<string, string> | undefined, hasBody: boolean): void {
  if (!hasBody) return
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === "content-type" && v?.trim()) return
  }
  throw new RequestValidationError("body requires a Content-Type header to be set", 400)
}

/** Minimal contract a Playwright `Route` exposes to `routeContinueOverrides`. */
export interface RouteLike {
  request(): { headers(): Record<string, string>; method(): string }
  continue(overrides: object): Promise<void>
}

/**
 * Build the `route.continue(...)` overrides for a tier 2/3/4 navigation,
 * applying caller-supplied headers + a POST rewrite when the upstream loaded
 * with GET. Content-Type is the caller's responsibility — see
 * `requireContentTypeForBody`.
 *
 * The `postData` key in the returned object is Playwright's literal
 * `Route.continue()` API field name — it is NOT TRAWL's `body` field. Playwright
 * has not renamed it; we can't either without breaking the contract.
 */
export function routeContinueOverrides(
  route: RouteLike,
  extraHeaders: Record<string, string> | undefined,
  method: string | undefined,
  body: string | undefined,
): { headers: Record<string, string>; method?: string; postData?: string } {
  const req = route.request()
  const headers = { ...req.headers(), ...extraHeaders }
  return method === "POST" && req.method() === "GET" ? { headers, method: "POST", postData: body } : { headers }
}
