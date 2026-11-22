import type { Page } from "patchright"
import { sleep } from "./deadline"
import { hasAwsWafCaptcha, hasAwsWafChallenge } from "./detect"

export type AwsWafResolution = "ok" | "ip-blocked" | "timeout" | "captcha-required"

interface WaitOptions {
  pollMs?: number
  stablePolls?: number
  redirectGraceMs?: number
  initialTokens?: ReadonlySet<string>
  signal?: AbortSignal
}

function domainMatches(host: string, cookieDomain: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase()
  return host === domain || host.endsWith(`.${domain}`)
}

export async function waitForAwsWafResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
  options: WaitOptions = {},
): Promise<AwsWafResolution> {
  if (timeoutMs <= 0 || options.signal?.aborted) return "timeout"
  const deadline = Date.now() + timeoutMs
  const pollMs = options.pollMs ?? 300
  const stablePolls = options.stablePolls ?? 2
  const redirectGraceMs = options.redirectGraceMs ?? 3000
  let clearPolls = 0
  let tokenAt: number | undefined
  let renavigated = false

  let targetHost = ""
  try {
    targetHost = new URL(originalUrl ?? page.url()).hostname.toLowerCase()
  } catch {}

  const initialTokens =
    options.initialTokens ??
    new Set(
      (
        await page
          .context()
          .cookies()
          .catch(() => [])
      )
        .filter((cookie) => cookie.name === "aws-waf-token" && domainMatches(targetHost, cookie.domain))
        .map((cookie) => `${cookie.domain}:${cookie.value}`),
    )

  while (Date.now() < deadline && !options.signal?.aborted) {
    const html = await page.content().catch(() => "")
    if (hasAwsWafCaptcha(html)) return "captcha-required"

    const challenged = !html || hasAwsWafChallenge(html)
    clearPolls = challenged ? 0 : clearPolls + 1

    const cookies = await page
      .context()
      .cookies()
      .catch(() => [])
    const hasNewToken = cookies.some(
      (cookie) =>
        cookie.name === "aws-waf-token" &&
        domainMatches(targetHost, cookie.domain) &&
        !initialTokens.has(`${cookie.domain}:${cookie.value}`),
    )

    if (hasNewToken) {
      tokenAt ??= Date.now()
      if (clearPolls >= stablePolls) {
        await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {})
        return options.signal?.aborted ? "timeout" : "ok"
      }

      if (originalUrl && !renavigated && Date.now() - tokenAt >= redirectGraceMs) {
        renavigated = true
        await page
          .goto(originalUrl, { waitUntil: "domcontentloaded", timeout: Math.max(1, deadline - Date.now()) })
          .catch(() => {})
      }
    }

    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), options.signal).catch(() => {})
  }

  return !options.signal?.aborted && tokenAt !== undefined ? "ip-blocked" : "timeout"
}
