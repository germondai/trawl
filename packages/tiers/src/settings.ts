import { faviconSettings } from "./favicons"
import { screenshotSettings } from "./screenshot"
import { blockedEvidenceSettings } from "./utils/blockedEvidence"
import { diagnosticSettings } from "./utils/capture"
import { redirectSettings } from "./utils/mainResponse"
import { responseCaptureSettings } from "./utils/responseCapture"

export const effectiveCaptureSettings = Object.freeze({
  ...screenshotSettings,
  ...faviconSettings,
  ...diagnosticSettings,
  ...redirectSettings,
  ...responseCaptureSettings,
  ...blockedEvidenceSettings,
})
