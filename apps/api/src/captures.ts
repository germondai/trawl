import { dirname, join } from "node:path"
import type { CaptureMode } from "@trawl/types"
import { CaptureStore } from "./captureStore"
import {
  HISTORY_CAPTURE_FALLBACK_HTML,
  HISTORY_CAPTURE_MAX_BYTES,
  HISTORY_CAPTURE_MAX_RECORDS,
  HISTORY_CAPTURE_MODE,
  HISTORY_CAPTURE_SCREENSHOT_HEIGHT,
  HISTORY_CAPTURE_SCREENSHOT_QUALITY,
  HISTORY_CAPTURE_SCREENSHOT_WIDTH,
  HISTORY_CAPTURE_STORAGE_BYTES,
  HISTORY_CAPTURE_TIMEOUT_MS,
  HISTORY_CAPTURE_TTL_SECONDS,
  METRICS_DB_PATH,
  OBSERVABILITY_ENABLED,
} from "./config"

export const historyScreenshotLimits = Object.freeze({
  width: HISTORY_CAPTURE_SCREENSHOT_WIDTH,
  height: HISTORY_CAPTURE_SCREENSHOT_HEIGHT,
  quality: HISTORY_CAPTURE_SCREENSHOT_QUALITY,
  timeoutMs: HISTORY_CAPTURE_TIMEOUT_MS,
})

export const captures = OBSERVABILITY_ENABLED
  ? new CaptureStore(join(dirname(METRICS_DB_PATH), "captures"), {
      mode: HISTORY_CAPTURE_MODE as CaptureMode,
      artifactBytes: HISTORY_CAPTURE_MAX_BYTES,
      totalBytes: HISTORY_CAPTURE_STORAGE_BYTES,
      records: HISTORY_CAPTURE_MAX_RECORDS,
      retentionMs: HISTORY_CAPTURE_TTL_SECONDS * 1000,
      fallbackHtml: HISTORY_CAPTURE_FALLBACK_HTML,
    })
  : undefined
