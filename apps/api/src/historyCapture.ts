import type { OrchestratorDeps } from "@trawl/tiers"
import type { BlockedEvidence, ScrapeRequest, ScrapeResult } from "@trawl/types"
import type { CaptureStore } from "./captureStore"

export interface HistoryScreenshotLimits {
  width: number
  height: number
  quality: number
  timeoutMs: number
}
type Observe = NonNullable<OrchestratorDeps["captureHistory"]>
interface Snapshot {
  tier: number
  image?: Uint8Array
  at: string
  reason?: string
}
let capturesInFlight = 0

function fitsScreenshot(bytes: Uint8Array, limits: Readonly<HistoryScreenshotLimits>): boolean {
  if (bytes[0] !== 255 || bytes[1] !== 216) return false
  let offset = 2
  const end = Math.min(bytes.length, 65536)
  while (offset + 8 < end) {
    if (bytes[offset++] !== 255) break
    while (offset < end && bytes[offset] === 255) offset++
    if (offset + 8 >= end) break
    const marker = bytes[offset++] ?? 0
    const size = (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0)
    if (size < 2 || offset + size > bytes.length) break
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      const height = (bytes[offset + 3] ?? 0) * 256 + (bytes[offset + 4] ?? 0)
      const width = (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0)
      return size >= 8 && width > 0 && height > 0 && width <= limits.width && height <= limits.height
    }
    if (marker === 218 || marker === 217) break
    offset += size
  }
  return false
}

/** Collect only the page owned by this operation. The retained value contains bytes, never a page or context. */
export function createHistoryCapture(
  store: CaptureStore,
  request: ScrapeRequest,
  limits: Readonly<HistoryScreenshotLimits>,
) {
  let snapshot: Snapshot | undefined
  const observe: Observe | undefined =
    store.policy.mode === "html"
      ? undefined
      : async (page, tier, budgetMs, existing) => {
          snapshot = { tier, at: new Date().toISOString(), reason: "screenshot-unavailable" }
          if (!store.hasCapacity || capturesInFlight >= 2) {
            snapshot.reason = "capture-busy"
            return
          }
          const viewport = page.viewportSize()
          if (viewport && (viewport.width <= 0 || viewport.height <= 0)) {
            snapshot.reason = "viewport-unavailable"
            return
          }
          if (existing && !request.screenshotFullPage && !request.screenshotSelector) {
            if (existing.length > Math.ceil(store.policy.artifactBytes / 3) * 4 + 4) {
              snapshot.reason = "artifact-byte-limit"
              return
            }
            const bytes = Buffer.from(existing, "base64")
            if (bytes.byteLength > store.policy.artifactBytes) {
              snapshot.reason = "artifact-byte-limit"
              return
            }
            if (fitsScreenshot(bytes, limits)) {
              snapshot.image = bytes
              delete snapshot.reason
              return
            }
          }
          // Leave a reserve for cookies, response delivery and normal tier cleanup.
          if (budgetMs < limits.timeoutMs + 1000) {
            snapshot.reason = "insufficient-request-budget"
            return
          }
          capturesInFlight++
          const image = Promise.resolve().then(() =>
            page.screenshot({
              type: "jpeg",
              quality: limits.quality,
              scale: "css",
              caret: "initial",
              timeout: limits.timeoutMs,
              clip: {
                x: 0,
                y: 0,
                width: Math.min(viewport?.width ?? limits.width, limits.width),
                height: Math.min(viewport?.height ?? limits.height, limits.height),
              },
            }),
          )
          // A timed-out protocol operation still owns its slot until it actually settles.
          void image.then(
            () => {
              capturesInFlight--
            },
            () => {
              capturesInFlight--
            },
          )
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const bytes = await Promise.race([
              image,
              new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), limits.timeoutMs)
              }),
            ])
            if (!bytes) {
              snapshot.reason = "capture-deadline"
              return
            }
            if (bytes.byteLength > store.policy.artifactBytes) {
              snapshot.reason = "artifact-byte-limit"
              return
            }
            if (!fitsScreenshot(bytes, limits)) {
              snapshot.reason = "screenshot-dimensions-limit"
              return
            }
            snapshot.image = bytes
            delete snapshot.reason
          } catch {
            snapshot.reason = "screenshot-unavailable"
          } finally {
            clearTimeout(timer)
          }
        }
  return {
    observe,
    commit(requestId: string, requestAt: string, result: ScrapeResult) {
      const selected = snapshot?.tier === result.tier ? snapshot : undefined
      store.capture({
        requestId,
        requestAt,
        html: result.html || undefined,
        contentType: result.contentType,
        screenshot: selected?.image,
        capturedAt: selected?.at,
        screenshotReason: selected?.reason ?? "no-browser-screenshot",
      })
      snapshot = undefined
    },
    failed(requestId: string, requestAt: string, evidence?: BlockedEvidence) {
      let image: Uint8Array | undefined
      let reason = "request-failed"
      if (evidence?.screenshot) {
        if (evidence.screenshot.length <= Math.ceil(store.policy.artifactBytes / 3) * 4 + 4) {
          const bytes = Buffer.from(evidence.screenshot, "base64")
          if (bytes.byteLength > store.policy.artifactBytes) reason = "artifact-byte-limit"
          else if (!fitsScreenshot(bytes, limits)) reason = "screenshot-dimensions-limit"
          else image = bytes
        } else reason = "artifact-byte-limit"
      }
      store.capture({
        requestId,
        requestAt,
        html: evidence?.html,
        htmlTruncated: evidence?.htmlTruncated,
        screenshot: image,
        screenshotReason: reason,
        contentType: "text/html; charset=utf-8",
      })
      snapshot = undefined
    },
  }
}
