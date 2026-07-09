import type { Cookie } from "@trawl/types"

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

// Maps Playwright's raw context.cookies() shape to TRAWL's Cookie type — shared by
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
