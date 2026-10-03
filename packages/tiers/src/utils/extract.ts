import type { ScrapeExtract } from "@trawl/types"
import type { Page } from "patchright"
import { captureLimit } from "./captureConfig"

// An extraction script is caller-supplied code that runs in the page, so every dimension is
// bounded the same way the favicon collector bounds its work: how large a script may be, how
// long the whole evaluation may take, and how much of the request's own budget is left. The
// caller's remaining budget caps the last of them.
const MAX_SCRIPT_CHARS = captureLimit(process.env.EXTRACT_MAX_SCRIPT_CHARS, 20_000)
const TOTAL_TIMEOUT_MS = captureLimit(process.env.EXTRACT_TIMEOUT_MS, 15_000)

/**
 * Runs a caller-supplied script inside the page that rendered the document.
 *
 * This is the general form of what `capturePageFavicons` already does: read something out of
 * the live page that the server's HTML cannot carry. A favicon fetch has to run in page
 * context to carry the origin's cookies, the session's challenge clearance and the same
 * egress the page was served over; the same is true of anything a caller wants to compute
 * from the rendered DOM. Evaluating it anywhere else — a second request from outside the
 * browser — knocks on the door as a stranger.
 *
 * `script` must be a self-contained *function expression* (`() => …` or `async () => …`). It
 * is invoked with `arg` when one is supplied, and its return value is handed back verbatim.
 * That value has to be serialisable across the CDP boundary, so it must be JSON-representable:
 * plain objects, arrays, strings, numbers, booleans and null. A page element or a DOM node
 * cannot cross and is rejected by the transport rather than silently flattened.
 *
 * Returns `undefined` rather than throwing. Extraction is a side artifact of a scrape, so a
 * script that fails or overruns degrades that one field and never the scrape itself — the
 * same contract as favicons and screenshots.
 */
export async function runPageExtract(
  page: Page,
  extract: ScrapeExtract | undefined,
  budgetMs = Number.POSITIVE_INFINITY,
): Promise<unknown> {
  if (!extract) return undefined
  const script = extract.script
  if (typeof script !== "string" || script.trim().length === 0 || script.length > MAX_SCRIPT_CHARS) {
    return undefined
  }

  const budget = Math.min(budgetMs, TOTAL_TIMEOUT_MS)
  if (!(budget > 0)) {
    console.log("[extract] skipped: the request's time budget is spent")
    return undefined
  }

  // The argument is inlined as a JSON literal rather than passed as Playwright's second
  // argument: that second argument is only interpreted for a function value, and `script`
  // arrives here as a string, so an inlined literal is what actually binds it.
  let expression: string
  try {
    expression = extract.arg === undefined ? `(${script})()` : `(${script})(${JSON.stringify(extract.arg)})`
  } catch {
    console.log("[extract] skipped: extract.arg is not JSON-serialisable")
    return undefined
  }

  try {
    return await page.evaluate(expression, { timeout: budget })
  } catch (err) {
    // A page that navigated away, a script that threw, or a value that could not cross the
    // CDP boundary all land here. None of them are worth failing the scrape over.
    console.log(`[extract] failed: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
