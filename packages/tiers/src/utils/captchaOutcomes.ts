import type { CaptchaOutcome } from "@trawl/types"

// Where a tier reports the CAPTCHAs it tried. The orchestrator attaches them to that
// tier's attempt, so a tier never needs to thread them through every return path.
export type CaptchaSink = (outcomes: CaptchaOutcome[]) => void

// Embedded widgets: every attempted kind either ended up solved or it did not.
export function widgetOutcomes(attempted: readonly string[], solved: readonly string[]): CaptchaOutcome[] {
  const cleared = new Set(solved)
  return attempted.map((kind) => ({ kind, outcome: cleared.has(kind) ? "solved" : "failed" }))
}

// Challenge walls: a wall solved locally reports its kinds as solved; a wall that stopped at a
// CAPTCHA no solver could clear is a failure of that wall's own kind. Other resolutions (a
// timeout, a plain block) are not CAPTCHA attempts and report nothing.
export function wallOutcomes(
  challengeType: string,
  resolution: string,
  solved: readonly string[] = [],
): CaptchaOutcome[] {
  const outcomes: CaptchaOutcome[] = solved.map((kind) => ({ kind, outcome: "solved" }))
  if (resolution === "captcha-required" && !solved.includes(challengeType)) {
    outcomes.push({ kind: challengeType, outcome: "failed" })
  }
  return outcomes
}
