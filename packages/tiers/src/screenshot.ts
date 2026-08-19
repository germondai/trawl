import type { Page } from "patchright"

// A screenshot is a best-effort side artifact of a scrape, so every step is bounded:
// the settle wait, the capture itself, and the size of the image we are willing to
// carry in the response. All are env-tunable.
const SETTLE_MS = Number(process.env.SCREENSHOT_SETTLE_MS ?? 3_000)
const CAPTURE_TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 10_000)
const JPEG_QUALITY = Number(process.env.SCREENSHOT_JPEG_QUALITY ?? 60)
const MAX_BYTES = Number(process.env.SCREENSHOT_MAX_BYTES ?? 4_000_000)

// Viewport only — never fullPage. A challenge wall or an infinite-scroll page stitches
// into a tall, mostly-empty canvas that costs seconds and shows less than the first
// screen does.
export async function capturePageScreenshot(page: Page): Promise<string | undefined> {
  try {
    // The HTML is read the moment a challenge clears, before late content (images,
    // fonts, lazy hydration) has painted. Give the page a bounded chance to settle,
    // then a short beat for whatever paints after the last request.
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {})
    await new Promise((r) => setTimeout(r, 300))

    const image = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, timeout: CAPTURE_TIMEOUT_MS })
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
