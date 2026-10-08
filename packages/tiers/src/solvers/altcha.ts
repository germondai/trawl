import type { Page } from "patchright"
import { sleep } from "../utils/deadline"

const POLL_INTERVAL_MS = 250

async function altchaVerified(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const input = document.querySelector('input[name="altcha"]')
      if (input instanceof HTMLInputElement && input.value.length > 20) return true

      const widget = document.querySelector("altcha-widget") as (HTMLElement & { getState?: () => string }) | null
      const state = widget?.getState?.() ?? widget?.getAttribute("state") ?? widget?.getAttribute("data-state")
      return state?.toLowerCase() === "verified"
    })
    .catch(() => false)
}

export async function hasAltchaWidget(page: Page, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)

  do {
    const detected = await page
      .evaluate(() => Boolean(document.querySelector('altcha-widget, input[name="altcha"]')))
      .catch(() => false)
    if (detected) return true

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal)
  } while (Date.now() < deadline)

  return false
}

export async function solveAltcha(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs

  try {
    if (!(await hasAltchaWidget(page, Math.min(5000, timeoutMs), signal))) return false
    if (await altchaVerified(page)) return true

    // ALTCHA v3 exposes verify() on its Web Component. Start it without awaiting
    // the potentially long PoW promise here; the bounded loop below owns timing.
    const invokedApi = await page
      .evaluate(() => {
        const widget = document.querySelector("altcha-widget") as
          | (HTMLElement & { verify?: () => Promise<unknown> })
          | null
        if (typeof widget?.verify !== "function") return false
        void widget.verify().catch(() => {})
        return true
      })
      .catch(() => false)

    // Older widget versions may expose only their checkbox. Use provider-specific
    // controls and never click the host element or a form submit button.
    if (!invokedApi) {
      const clickBudget = Math.max(0, Math.min(2000, deadline - Date.now()))
      let clicked = false
      if (clickBudget > 0) {
        clicked = await page
          .locator('altcha-widget input[type="checkbox"], altcha-widget .altcha-checkbox')
          .first()
          .click({ timeout: clickBudget, force: true })
          .then(() => true)
          .catch(() => false)
      }
      if (!clicked) {
        await page
          .evaluate(() => {
            const widget = document.querySelector("altcha-widget")
            const control = widget?.shadowRoot?.querySelector(
              'input[type="checkbox"], .altcha-checkbox',
            ) as HTMLElement | null
            control?.click()
          })
          .catch(() => {})
      }
    }

    while (Date.now() < deadline) {
      if (await altchaVerified(page)) {
        const settleBudget = Math.min(6000, Math.max(0, deadline - Date.now()))
        const settles: Promise<unknown>[] = []
        if (settleBudget > 0 && typeof page.waitForNavigation === "function") {
          settles.push(page.waitForNavigation({ timeout: settleBudget, waitUntil: "load" }).catch(() => {}))
        }
        if (settleBudget > 0 && typeof page.waitForFunction === "function") {
          settles.push(
            page
              .waitForFunction(() => !document.querySelector("altcha-widget, #altcha-form, .captcha-wrap"), {
                timeout: settleBudget,
              })
              .catch(() => {}),
          )
        }
        if (settles.length > 0) await Promise.race(settles)
        return true
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal)
    }
  } catch (err) {
    console.log("[altcha] error:", err instanceof Error ? err.message : err)
  }

  return false
}
