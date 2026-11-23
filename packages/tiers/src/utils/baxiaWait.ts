import type { Page } from "patchright"
import { persistentBrowserWall } from "./browserWall"
import { sleep } from "./deadline"

// The cookie response can precede the widget's navigation. An old load state does
// not prove the destination is ready, and replaying the request could repeat a POST.
export async function waitForBaxiaNavigation(
  page: Page,
  timeoutMs: number,
  signal?: AbortSignal,
  responseHeaders: () => Record<string, string> = () => ({}),
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline && !signal?.aborted) {
    const html = await page.content().catch(() => "")
    if (
      html &&
      persistentBrowserWall(html, page.url(), responseHeaders(), 200, "baxia")?.reason !== "baxia-persistent"
    ) {
      await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {})
      return
    }
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())), signal)
  }
}
