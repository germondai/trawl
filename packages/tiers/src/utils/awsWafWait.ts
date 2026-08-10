import type { Page } from "patchright"
import {
  type AwsWafCaptchaSolverOptions,
  getAwsWafToken,
  hasAwsWafCaptchaWidget,
  solveAwsWafCaptcha,
} from "../solvers/awsWaf"
import { getAwsWafAction, hasAwsWafCaptcha, hasAwsWafInterstitial } from "./detect"

export interface AwsWafResolution {
  status: "ok" | "timeout"
  captchaSolved: boolean
}

export interface AwsWafWaitOptions {
  solveCaptcha?: typeof solveAwsWafCaptcha
  solverOptions?: AwsWafCaptchaSolverOptions
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Handles both AWS's silent Challenge action (202) and interactive CAPTCHA
// action (405). The official script updates aws-waf-token and normally reloads
// the original URL itself; if that reload stalls, we navigate after the token
// update just like the Cloudflare waiter does for cf_clearance.
export async function waitForAwsWafResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
  responseHeaders: () => Record<string, string> = () => ({}),
  options: AwsWafWaitOptions = {},
): Promise<AwsWafResolution> {
  if (timeoutMs <= 0) return { status: "timeout", captchaSolved: false }

  const sleep = options.sleep ?? defaultSleep
  const solveCaptcha = options.solveCaptcha ?? solveAwsWafCaptcha
  const deadline = Date.now() + timeoutMs
  const targetHost = hostnameOf(originalUrl ?? page.url())
  const initialToken = await getAwsWafToken(page, targetHost)
  let tokenUpdatedAt: number | undefined
  let inactiveSamples = 0
  let captchaRequired = false
  let captchaSolved = false
  let solveAttempted = false

  await sleep(250)

  while (Date.now() < deadline) {
    try {
      const html = await page.content().catch(() => "")
      const headers = responseHeaders()
      const action = getAwsWafAction(headers)
      const widgetVisible = await hasAwsWafCaptchaWidget(page, 0)
      const active = hasAwsWafInterstitial(html, headers) || widgetVisible

      captchaRequired ||= action === "captcha" || hasAwsWafCaptcha(html) || widgetVisible

      if (active) inactiveSamples = 0
      else inactiveSamples++

      // Two samples avoid treating the transient blank document between AWS's
      // voucher exchange and reload as the final page.
      if (inactiveSamples >= 2) {
        await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
        return { status: "ok", captchaSolved }
      }

      if (captchaRequired && widgetVisible && !solveAttempted) {
        solveAttempted = true
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        captchaSolved = await solveCaptcha(page, remaining, options.solverOptions)
        continue
      }

      const token = await getAwsWafToken(page, targetHost)
      const tokenUpdated = Boolean(token && token !== initialToken)
      if (tokenUpdated && (!captchaRequired || captchaSolved)) {
        if (tokenUpdatedAt === undefined) {
          tokenUpdatedAt = Date.now()
          console.log("[aws-waf] aws-waf-token updated")
        }

        // Give AWS's own reload a chance first. This fallback is mainly for
        // interrupted Firefox navigations and pages that swallow the promise.
        if (originalUrl && Date.now() - tokenUpdatedAt > 2500) {
          console.log("[aws-waf] token set but interstitial persisted — navigating to original URL")
          await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {})
          await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
        }
      }
    } catch {
      // AWS replaces the document while exchanging the voucher and token. Keep
      // polling when the execution context disappears mid-sample.
    }

    await sleep(250)
  }

  return { status: "timeout", captchaSolved }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}
