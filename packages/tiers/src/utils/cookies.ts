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
