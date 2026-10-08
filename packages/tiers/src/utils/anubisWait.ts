import type { Page } from "patchright"
import { inspectAnubisDocument, isAnubisVerificationUrl } from "./anubis"

export type AnubisResolution = "ok" | "timeout" | "blocked" | "browser-closed"

// The site's own browser JS performs the PoW; no reload or separate solve retry.
export async function waitForAnubisResolution(
  page: Page,
  timeoutMs: number,
  _originalUrl?: string,
): Promise<AnubisResolution> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let clearUrl: string | undefined
  while (Date.now() < deadline) {
    if (page.isClosed()) return "browser-closed"
    let cancel = () => {}
    const sample = await Promise.race([
      page.evaluate(inspectAnubisDocument, undefined).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()))
        cancel = () => clearTimeout(timer)
      }),
    ]).finally(() => cancel())
    if (Date.now() >= deadline) return "timeout"
    const url = page.url()
    if (sample?.state === "blocked" || /^about:(?:neterror|certerror)/.test(url)) return "blocked"
    if (sample && !sample.state && sample.ready && sample.content && !isAnubisVerificationUrl(url)) {
      if (url === clearUrl) return "ok"
      clearUrl = url
    } else clearUrl = undefined
    await new Promise((resolve) => setTimeout(resolve, Math.min(300, Math.max(1, deadline - Date.now()))))
  }
  return "timeout"
}
