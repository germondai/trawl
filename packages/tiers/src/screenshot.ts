import type { Page } from "patchright"
import { captureLimit } from "./utils/captureConfig"
import { waitForVisibleSelector } from "./utils/waitForVisibleSelector"

// A screenshot is a best-effort side artifact of a scrape, so every step is bounded:
// the settle wait, the capture itself, and the size of the image we are willing to
// carry in the response. All are env-tunable.
const SETTLE_MS = captureLimit(process.env.SCREENSHOT_SETTLE_MS, 3_000)
const CAPTURE_TIMEOUT_MS = captureLimit(process.env.SCREENSHOT_TIMEOUT_MS, 10_000)
const configuredQuality = captureLimit(process.env.SCREENSHOT_JPEG_QUALITY, 60)
const JPEG_QUALITY = configuredQuality >= 1 && configuredQuality <= 100 ? configuredQuality : 60
const MAX_BYTES = captureLimit(process.env.SCREENSHOT_MAX_BYTES, 4_000_000)
const MAX_FULL_PAGE_HEIGHT = 6_000
const MAX_FULL_PAGE_PIXELS = 12_000_000
const SELECTOR_WAIT_MS = 10_000

async function withinBudget<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("screenshot operation timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function exceedsCanvasLimit(width: number, height: number): boolean {
  return (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    height > MAX_FULL_PAGE_HEIGHT ||
    width * height > MAX_FULL_PAGE_PIXELS
  )
}

export async function capturePageScreenshot(
  page: Page,
  budgetMs = Number.POSITIVE_INFINITY,
  options: { settle?: boolean; fullPage?: boolean; waitForSelector?: string; selector?: string } = {},
): Promise<string | undefined> {
  const deadline = Date.now() + Math.max(budgetMs, 0)
  const remaining = (): number => Math.max(deadline - Date.now(), 0)

  try {
    if (options.fullPage && options.selector) return undefined
    // The HTML is read the moment a challenge clears, before late content (images,
    // fonts, lazy hydration) has painted. Give the page a bounded chance to settle,
    // then a short beat for whatever paints after the last request. A caller imaging a
    // page that will never settle (a challenge wall) opts out of the wait.
    if (remaining() <= 0) return undefined
    if (options.waitForSelector) {
      const waitMs = Math.min(SELECTOR_WAIT_MS, remaining())
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          page.waitForSelector(options.waitForSelector, { state: "visible", timeout: waitMs }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("screenshot selector wait timed out")), waitMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    if (options.settle !== false) {
      await page.waitForLoadState("networkidle", { timeout: Math.min(SETTLE_MS, remaining()) }).catch(() => {})
      const paintWaitMs = Math.min(300, remaining())
      if (paintWaitMs > 0) await new Promise((r) => setTimeout(r, paintWaitMs))
    }

    if (options.fullPage) {
      const size = await withinBudget(
        page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth),
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight),
        })),
        Math.min(CAPTURE_TIMEOUT_MS, remaining()),
      )
      if (exceedsCanvasLimit(size.width, size.height)) {
        console.log(
          `[screenshot] full-page capture exceeds ${MAX_FULL_PAGE_HEIGHT}px or ${MAX_FULL_PAGE_PIXELS} pixels`,
        )
        return undefined
      }
    }

    let locator: ReturnType<Page["locator"]> | undefined
    if (options.selector) {
      if (!(await waitForVisibleSelector(page, options.selector, remaining()))) return undefined
      locator = page.locator(options.selector).filter({ visible: true }).first()
      const box = await withinBudget(
        locator.boundingBox({ timeout: Math.min(CAPTURE_TIMEOUT_MS, remaining()) }),
        Math.min(CAPTURE_TIMEOUT_MS, remaining()),
      )
      if (!box || exceedsCanvasLimit(box.width, box.height)) {
        console.log(`[screenshot] element exceeds ${MAX_FULL_PAGE_HEIGHT}px or ${MAX_FULL_PAGE_PIXELS} pixels`)
        return undefined
      }
    }

    const captureTimeout = Math.min(CAPTURE_TIMEOUT_MS, remaining())
    if (captureTimeout <= 0) return undefined
    const image = locator
      ? await locator.screenshot({ type: "jpeg", quality: JPEG_QUALITY, timeout: captureTimeout })
      : await page.screenshot({
          type: "jpeg",
          quality: JPEG_QUALITY,
          timeout: captureTimeout,
          ...(options.fullPage ? { fullPage: true } : {}),
        })
    if (image.length > MAX_BYTES) {
      console.log(`[screenshot] dropped: ${image.length}b exceeds SCREENSHOT_MAX_BYTES=${MAX_BYTES}`)
      return undefined
    }
    return Buffer.from(image).toString("base64")
  } catch (err) {
    console.log(`[screenshot] capture failed: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

export const screenshotSettings = Object.freeze({
  SCREENSHOT_SETTLE_MS: SETTLE_MS,
  SCREENSHOT_TIMEOUT_MS: CAPTURE_TIMEOUT_MS,
  SCREENSHOT_JPEG_QUALITY: JPEG_QUALITY,
  SCREENSHOT_MAX_BYTES: MAX_BYTES,
})
