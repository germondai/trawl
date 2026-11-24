import type { CaptchaOutcome } from "@trawl/types"

// Where a tier reports the CAPTCHAs it tried. The orchestrator attaches them to that
// tier's attempt, so a tier never needs to thread them through every return path.
export type CaptchaSink = (outcomes: CaptchaOutcome[]) => void

// Embedded widgets: every attempted kind either ended up solved or it did not.
export function widgetOutcomes(attempted: readonly string[], solved: readonly string[]): CaptchaOutcome[] {
  const cleared = new Set(solved)
  return attempted.map((kind) => ({ kind, outcome: cleared.has(kind) ? "solved" : "failed" }))
}
