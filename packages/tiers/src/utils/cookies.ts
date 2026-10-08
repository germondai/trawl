import type { Cookie, InputCookie } from "@trawl/types"
import { RequestValidationError } from "./sanitize"

export function normalizeInputCookies(cookies: InputCookie[], url: string) {
  if (!Array.isArray(cookies) || cookies.length > 200)
    throw new RequestValidationError("cookies must be an array of at most 200 cookies", 400)
  let chars = 0
  return cookies.map((cookie) => {
    if (!cookie || typeof cookie.name !== "string" || !cookie.name || typeof cookie.value !== "string")
      throw new RequestValidationError("Each cookie requires a name and string value", 400)
    chars += cookie.name.length + cookie.value.length
    if (chars > 1_000_000) throw new RequestValidationError("Cookie input exceeds the size limit", 400)
    for (const field of ["domain", "path"] as const) {
      if (cookie[field] !== undefined && (typeof cookie[field] !== "string" || !cookie[field]))
        throw new RequestValidationError(`Cookie ${field} must be a non-empty string`, 400)
    }
    if (cookie.path !== undefined && !cookie.path.startsWith("/"))
      throw new RequestValidationError("Cookie path must start with /", 400)
    const expires = cookie.expires ?? cookie.expiry
    if (expires !== undefined && (!Number.isFinite(expires) || (expires < 0 && expires !== -1)))
      throw new RequestValidationError("Cookie expiry must be Unix seconds or -1", 400)
    for (const field of ["httpOnly", "secure"] as const)
      if (cookie[field] !== undefined && typeof cookie[field] !== "boolean")
        throw new RequestValidationError(`Cookie ${field} must be a boolean`, 400)
    if (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(cookie.sameSite))
      throw new RequestValidationError("Invalid cookie sameSite", 400)
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? new URL(url).hostname,
      path: cookie.path ?? "/",
      ...(expires === undefined ? {} : { expires }),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }
  })
}

interface RawCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}

// Playwright's cookie.sameSite is `"Strict" | "Lax" | "None"` but can be undefined when
// the cookie was set without an explicit sameSite. Normalize to the Playwright literal
// union with a default of "Lax" (matches browser default for same-origin cookies).
export function normalizeSameSite(s: string | undefined): "Strict" | "Lax" | "None" {
  return s === "Strict" || s === "Lax" || s === "None" ? s : "Lax"
}

// Maps Playwright's raw context.cookies() shape to TRAWL's Cookie type - shared by
// tiers 2-4, which each read cookies back off the browser context after a successful load.
export function toCookies(rawCookies: RawCookie[]): Cookie[] {
  return rawCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }))
}

// Cookie values a challenge waiter must be able to tell apart from the ones it earns itself.
// Both AWS WAF and DataDome hand out their cookie on the block page too, so a waiter proves
// nothing by finding one: it has to find a value that was not there before the run.
export interface ChallengeCookieSnapshot {
  awsWaf: ReadonlySet<string>
  dataDome: ReadonlySet<string>
}

export function snapshotChallengeCookies(
  rawCookies: Array<{ name: string; domain: string; value: string }>,
): ChallengeCookieSnapshot {
  const awsWaf = new Set<string>()
  const dataDome = new Set<string>()
  for (const cookie of rawCookies) {
    if (cookie.name === "aws-waf-token") awsWaf.add(`${cookie.domain}:${cookie.value}`)
    else if (cookie.name === "datadome") dataDome.add(`${cookie.domain}:${cookie.value}`)
  }
  return { awsWaf, dataDome }
}
