import { sleep } from "../utils/deadline"
// Cloudflare Turnstile solver — handles both:
//
// 1. Interstitial mode: CF serves a full-page Turnstile challenge BEFORE
//    letting the user through. The challengeWait.ts loop handles this by
//    clicking the iframe widget while polling for cf_clearance.
//
// 2. Embedded mode: The page itself contains a <div class="cf-turnstile"> widget.
//    This is used by sites as a form protection (not as a page gate).
//    Solving it generates a turnstile token in the hidden input, which the
//    page's JS can then use to allow form submission or reveal content.
//
// Non-interactive mode: When Cloudflare determines the browser has a good
// risk score (Camoufox Firefox, residential IP, no automation signals), Turnstile
// auto-solves without any click — a spinner briefly appears then turns into
// a green checkmark.

import type { Page } from "patchright"

import { attemptTurnstileClick } from "../utils/challengeWait"

export async function solveTurnstile(page: Page, timeoutMs = 25_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs

  // With Camoufox (Firefox + geoip), Turnstile often auto-solves immediately.
  // The token lands in the hidden input before the iframe even appears.
  if (await turnstileVerified(page)) return true

  // Reuse the interstitial's shadow-DOM and coordinate click paths. The iframe
  // remains mounted after an embedded widget succeeds; its response is the proof.
  let lastClick = 0
  while (Date.now() < deadline && !signal.aborted) {
    if (await turnstileVerified(page)) return true
    if (Date.now() - lastClick >= 3000 && deadline - Date.now() > 2000) {
      lastClick = Date.now()
      await attemptTurnstileClick(page, false).catch(() => {})
    }
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())), signal)
  }
  return false
}

async function turnstileVerified(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const valid = (value: unknown) => typeof value === "string" && value.length > 10
      if (
        Array.from(document.querySelectorAll<HTMLInputElement>('[name="cf-turnstile-response"]')).some((el) =>
          valid(el.value),
        )
      )
        return true
      const api = (window as unknown as { turnstile?: { getResponse?: () => string } }).turnstile
      try {
        return valid(api?.getResponse?.())
      } catch {
        return false
      }
    })
    .catch(() => false)
}

export async function hasTurnstileWidget(page: Page): Promise<boolean> {
  return page
    .locator('.cf-turnstile, #cf-turnstile, input[name="cf-turnstile-response"]')
    .isVisible({ timeout: 2000 })
    .catch(() => false)
}
