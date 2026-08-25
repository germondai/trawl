import type { Page } from "patchright"
import { getDataDomeAction } from "./detect"

export type DataDomeResolution = "ok" | "ip-blocked" | "timeout" | "captcha-required"

interface WaitOptions {
  pollMs?: number
  stablePolls?: number
  redirectGraceMs?: number
  initialCookies?: ReadonlySet<string>
}

function domainMatches(host: string, cookieDomain: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase()
  return host === domain || host.endsWith(`.${domain}`)
}

// DataDome's Device Check runs i.js in the page, posts its telemetry, and redirects back to
// the protected resource with a fresh `datadome` cookie. The block page itself already carries
// a `datadome` cookie, so only a CHANGED value proves the check passed.
//
// The interactive slider (c.js) and the hard block (t=bv) are terminal for this waiter: no
// amount of waiting clears them.
export async function waitForDataDomeResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
  options: WaitOptions = {},
): Promise<DataDomeResolution> {
  if (timeoutMs <= 0) return "timeout"
  const deadline = Date.now() + timeoutMs
  const pollMs = options.pollMs ?? 300
  const stablePolls = options.stablePolls ?? 2
  const redirectGraceMs = options.redirectGraceMs ?? 3000
  let clearPolls = 0
  let cookieAt: number | undefined
  let renavigated = false

  let targetHost = ""
  try {
    targetHost = new URL(originalUrl ?? page.url()).hostname.toLowerCase()
  } catch {}

  const initialCookies =
    options.initialCookies ??
    new Set(
      (
        await page
          .context()
          .cookies()
          .catch(() => [])
      )
        .filter((cookie) => cookie.name === "datadome" && domainMatches(targetHost, cookie.domain))
        .map((cookie) => `${cookie.domain}:${cookie.value}`),
    )

  while (Date.now() < deadline) {
    const html = await page.content().catch(() => "")
    const action = getDataDomeAction(html)
    if (action === "captcha") return "captcha-required"
    if (action === "blocked") return "ip-blocked"

    const challenged = !html || action !== undefined
    clearPolls = challenged ? 0 : clearPolls + 1

    const cookies = await page
      .context()
      .cookies()
      .catch(() => [])
    const hasNewCookie = cookies.some(
      (cookie) =>
        cookie.name === "datadome" &&
        domainMatches(targetHost, cookie.domain) &&
        !initialCookies.has(`${cookie.domain}:${cookie.value}`),
    )

    if (hasNewCookie) {
      cookieAt ??= Date.now()
      if (clearPolls >= stablePolls) {
        await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {})
        return "ok"
      }

      // The Device Check redirect does not always fire on its own once the cookie is issued.
      if (originalUrl && !renavigated && Date.now() - cookieAt >= redirectGraceMs) {
        renavigated = true
        await page
          .goto(originalUrl, { waitUntil: "domcontentloaded", timeout: Math.max(1, deadline - Date.now()) })
          .catch(() => {})
      }
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }

  return cookieAt !== undefined ? "ip-blocked" : "timeout"
}
