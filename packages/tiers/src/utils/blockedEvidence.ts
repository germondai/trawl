import type { BlockedEvidence } from "@trawl/types"
import type { Page } from "patchright"
import { capturePageScreenshot } from "../screenshot"
import { captureLimit } from "./captureConfig"

// The wall is the only artifact a blocked scrape has to hand back, and it is terminal-path
// data: a request that did not ask for it attaches nothing and reads nothing, and a capture
// that fails degrades the evidence rather than the outcome. One bounded wall is kept per
// request, and malformed configuration falls back to the documented safe default.
const MAX_HTML_CHARS = captureLimit(process.env.BLOCKED_EVIDENCE_MAX_HTML_CHARS, 512_000)

export interface BlockedEvidenceSink {
  // Take an image of the wall too, on the branches that have not already taken one.
  screenshot?: boolean
  report(evidence: BlockedEvidence): void
}

export interface BlockedOutcome {
  tier: 2 | 3 | 4
  status: BlockedEvidence["status"]
  reason?: string
  statusCode?: number
  // Always reuse markup the tier already holds. Reading the full DOM again after a
  // timeout would make the diagnostic path exceed the request's time and memory bounds.
  html: string
  screenshot?: string
}

export async function reportBlocked(
  page: Page,
  sink: BlockedEvidenceSink | undefined,
  outcome: BlockedOutcome,
  budgetMs: number,
): Promise<void> {
  if (!sink) return
  try {
    // settle: false - a challenge wall never reaches network idle, so waiting for it only
    // spends the budget the next tier still needs. The screenshot still obeys the
    // request's remaining budget and its own configured time and size ceilings.
    const screenshot =
      outcome.screenshot ??
      (sink.screenshot ? await capturePageScreenshot(page, budgetMs, { settle: false }) : undefined)
    sink.report({
      tier: outcome.tier,
      status: outcome.status,
      reason: outcome.reason,
      url: page.url(),
      statusCode: outcome.statusCode,
      html: outcome.html.slice(0, MAX_HTML_CHARS),
      htmlTruncated: outcome.html.length > MAX_HTML_CHARS ? true : undefined,
      screenshot,
    })
  } catch (err) {
    console.log(`[blocked-evidence] capture failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
