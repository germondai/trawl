// Pieces of the DataDome wall that the slider and the audio solver both read. The wall is one
// iframe on captcha-delivery.com that offers both ways of passing; what differs is only how the
// answer is given, not how a verdict is recognised.

import type { Frame, Page } from "patchright"
import { sleep } from "../utils/deadline"

export const PASSED = '#analyticsCaptchaPassed[data-analytics-captcha-passed="true"]'

// DataDome words its "access restricted" page per language; none of them offers a control.
export const RESTRICTED =
  /temporarily restricted|temporariamente restrito|temporairement restreint|vorübergehend eingeschränkt|temporalmente restringido/i

export async function present(frame: Frame, selector: string): Promise<boolean> {
  return frame
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false)
}

export function hasWallFrame(page: Page): boolean {
  return page.frames().some((frame) => {
    try {
      return /captcha-delivery\.com/i.test(frame.url())
    } catch {
      return false
    }
  })
}

export async function findFrame(page: Page, selectors: string[]): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      if (await present(frame, selector)) return frame
    }
  }
}

export async function isRestricted(frame: Frame): Promise<boolean> {
  try {
    const text = await frame.locator("body").textContent({ timeout: 1000 })
    return RESTRICTED.test(text ?? "")
  } catch {
    return false
  }
}

// The widget flags a passed verification in its own markup. A detached frame proves nothing:
// DataDome also replaces it with the "access restricted" page when it turns an answer away.
export async function accepted(frame: Frame): Promise<boolean> {
  return (
    (await frame
      .locator(PASSED)
      .count()
      .catch(() => 0)) > 0
  )
}

// DataDome often answers an accepted answer by swapping the whole wall iframe for a new one
// that holds the restricted page, so the frame that took the answer is already detached by then.
// Every wall frame on the page is read, not only the original.
export async function wallRestricted(page: Page, frame: Frame): Promise<boolean> {
  if (!frame.isDetached() && (await isRestricted(frame))) return true
  for (const other of page.frames()) {
    if (other === frame) continue
    let onWall = false
    try {
      onWall = /captcha-delivery\.com/i.test(other.url())
    } catch {}
    if (onWall && (await isRestricted(other))) return true
  }
  return false
}

// A flagged pass is not clearance: DataDome can still turn the session away a moment later, in
// the same frame or in a replacement for it. The wall is watched for `settleMs` and the pass only
// stands if it stays clean.
export async function settledAfterAccept(
  page: Page,
  frame: Frame,
  settleMs: number,
  signal: AbortSignal,
  remaining: () => number,
): Promise<"passed" | "restricted"> {
  const until = Date.now() + Math.max(0, Math.min(settleMs, remaining()))
  while (Date.now() < until && !signal.aborted) {
    if (await wallRestricted(page, frame)) return "restricted"
    await sleep(Math.min(300, Math.max(1, until - Date.now())), signal).catch(() => {})
  }
  return (await wallRestricted(page, frame)) ? "restricted" : "passed"
}
