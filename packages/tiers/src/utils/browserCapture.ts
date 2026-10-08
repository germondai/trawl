import type { Page } from "patchright"
import { capturePageScreenshot } from "../screenshot"
import type { attachPageCapture, CaptureOptions } from "./capture"
import type { RequestBudget } from "./deadline"
import { waitForVisibleSelector } from "./waitForVisibleSelector"

export async function waitForBrowserLoad(
  page: Page,
  capture: CaptureOptions,
  budget: RequestBudget,
  idleTimeoutMs: number,
) {
  // An explicit selector supplies readiness; otherwise retain the default JS settle.
  const state = capture.contentWaitForSelector ? "load" : "networkidle"
  const timeout = Math.max(1, Math.min(state === "load" ? 5000 : idleTimeoutMs, budget.remaining()))
  await page.waitForLoadState(state, { timeout }).catch(() => {})
}

export async function captureBrowserDocument(
  page: Page,
  capture: CaptureOptions,
  pageCapture: ReturnType<typeof attachPageCapture>,
  budget: RequestBudget,
  screenshot?: boolean,
) {
  await pageCapture.settle(budget.remaining())
  if (capture.contentWaitForSelector) {
    await waitForVisibleSelector(page, capture.contentWaitForSelector, budget.remaining())
  }
  // Capture the image before draining and reading HTML so both describe the settled page.
  const shot = screenshot
    ? await capturePageScreenshot(page, budget.remaining(), {
        fullPage: capture.screenshotFullPage,
        waitForSelector: capture.screenshotWaitForSelector,
        selector: capture.screenshotSelector,
      })
    : undefined
  const evidence = await pageCapture.drain(budget.remaining())
  return { html: await page.content(), shot, evidence }
}
