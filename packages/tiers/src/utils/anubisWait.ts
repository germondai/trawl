import type { Page } from "patchright"
import { hasAnubisDestinationContent, inspectAnubisPage, isAnubisVerificationUrl } from "./anubis"
import { isBrowserErrorPage } from "./detect"

export interface AnubisWaitOptions {
  pollMs?: number
  response?: () => { status: number; url?: string }
}

async function withinBudget<T>(action: () => Promise<T>, budgetMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// Run the site's own PoW. An error document, a verification endpoint, or an
// endless reissue loop must not be mistaken for the destination content.
export async function waitForAnubisResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
  options: AnubisWaitOptions = {},
): Promise<"ok" | "timeout" | "blocked" | "browser-closed"> {
  if (timeoutMs <= 0) return "timeout"
  const deadline = Date.now() + timeoutMs
  let clearSamples = 0
  let clearUrl: string | undefined
  let challengeId: string | undefined
  let reissues = 0
  while (Date.now() < deadline) {
    if (typeof page.isClosed === "function" && page.isClosed()) return "browser-closed"
    const sample = await withinBudget(
      async () => {
        const html = await page.content()
        const ready = typeof page.evaluate === "function" ? await page.evaluate(() => document.readyState) : undefined
        return { html, ready, url: typeof page.url === "function" ? page.url() : originalUrl }
      },
      Math.max(1, deadline - Date.now()),
    )
    if (Date.now() >= deadline) return "timeout"
    if (sample) {
      const { html, ready, url } = sample
      const state = inspectAnubisPage(html)
      const response = options.response?.()
      if (state?.state === "blocked") return "blocked"
      // Error status on the challenge itself may be configured intentionally;
      // only reject it once we have left that challenge document.
      if (!state && response && response.status >= 400) return "blocked"
      if (state?.challengeId && state.challengeId !== challengeId) {
        if (challengeId && ++reissues >= 2) return "blocked"
        challengeId = state.challengeId
      }
      if (!state && ready !== "loading" && html && !isBrowserErrorPage(html) && hasAnubisDestinationContent(html)) {
        if (url && isAnubisVerificationUrl(url)) return "blocked"
        if (url !== clearUrl) clearSamples = 0
        clearUrl = url
        if (++clearSamples >= 2) return "ok"
      } else {
        clearSamples = 0
        clearUrl = undefined
      }
    } else {
      clearSamples = 0
      clearUrl = undefined
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(Math.max(1, options.pollMs ?? 100), Math.max(1, deadline - Date.now()))),
    )
  }
  return "timeout"
}
