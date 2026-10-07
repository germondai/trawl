import type { Page } from "patchright"
import { sleep } from "../utils/deadline"

const POLL_INTERVAL_MS = 250
const WIDGET_SELECTOR = ".frc-captcha"
const SOLUTION_SELECTOR = 'input[name="frc-captcha-solution"], input[name="frc-captcha-response"]'

const isProviderFrame = (url: string) => /(?:frcapi\.com|friendlycaptcha\.[^/]+)\/.+(?:captcha\/)?widget/i.test(url)

async function friendlyCaptchaVerified(page: Page): Promise<boolean> {
  return page
    .evaluate(
      ({ solutionSelector, widgetSelector }) => {
        const validResponse = (value: unknown) =>
          typeof value === "string" && value.length > 20 && !value.startsWith(".")
        const input = document.querySelector(solutionSelector)
        if (input instanceof HTMLInputElement && validResponse(input.value)) return true

        const mount = document.querySelector(widgetSelector) as
          | (HTMLElement & {
              frcWidget?: { getResponse?: () => string; getState?: () => string }
            })
          | null
        return mount?.frcWidget?.getState?.() === "completed" && validResponse(mount.frcWidget.getResponse?.())
      },
      { solutionSelector: SOLUTION_SELECTOR, widgetSelector: WIDGET_SELECTOR },
    )
    .catch(() => false)
}

export async function hasFriendlyCaptchaWidget(page: Page, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)

  do {
    const viaDom = await page
      .evaluate(
        ({ solutionSelector, widgetSelector }) =>
          Boolean(document.querySelector(widgetSelector) || document.querySelector(solutionSelector)),
        { solutionSelector: SOLUTION_SELECTOR, widgetSelector: WIDGET_SELECTOR },
      )
      .catch(() => false)
    if (viaDom || page.frames().some((frame) => frame !== page.mainFrame() && isProviderFrame(frame.url()))) {
      return true
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal)
  } while (Date.now() < deadline)

  return false
}

export async function solveFriendlyCaptcha(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs

  try {
    if (!(await hasFriendlyCaptchaWidget(page, Math.min(3000, timeoutMs)))) return false
    if (await friendlyCaptchaVerified(page)) return true

    // Friendly Captcha v2 exposes the supported start() API on the mount node.
    // It handles auto/focus/none start modes without guessing at page controls.
    let invokedApi = false
    let clickedControl = false

    while (Date.now() < deadline) {
      if (await friendlyCaptchaVerified(page)) return true

      // The SDK and its cross-origin widget frame are added asynchronously. Retry
      // discovery within the same deadline rather than taking a one-time snapshot.
      if (!invokedApi) {
        invokedApi = await page
          .evaluate((widgetSelector) => {
            const mount = document.querySelector(widgetSelector) as
              | (HTMLElement & { frcWidget?: { start?: () => void } })
              | null
            if (typeof mount?.frcWidget?.start !== "function") return false
            mount.frcWidget.start()
            return true
          }, WIDGET_SELECTOR)
          .catch(() => false)
      }

      if (!clickedControl) {
        const clickBudget = Math.max(0, Math.min(750, deadline - Date.now()))
        const frame = page
          .frames()
          .find((candidate) => candidate !== page.mainFrame() && isProviderFrame(candidate.url()))
        if (frame && clickBudget > 0) {
          clickedControl = await frame
            .locator('button[role="checkbox"], .frc-button')
            .first()
            .click({ timeout: clickBudget, force: true })
            .then(() => true)
            .catch(() => false)
        } else if (clickBudget > 0) {
          // Friendly Captcha v1 renders .frc-button in the embedding document.
          const legacy = page.locator(".frc-captcha .frc-button")
          if ((await legacy.count().catch(() => 0)) > 0) {
            clickedControl = await legacy
              .first()
              .click({ timeout: clickBudget, force: true })
              .then(() => true)
              .catch(() => false)
          }
        }
      }

      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal)
    }
  } catch (err) {
    console.log("[friendly-captcha] error:", err instanceof Error ? err.message : err)
  }

  return false
}
