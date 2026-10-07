import type { Page } from "patchright"
import { sleep } from "../utils/deadline"

export async function hasCapWidget(page: Page, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    if (signal?.aborted) return false
    const found = await page
      .evaluate(() => {
        const widget = document.querySelector<HTMLElement & { solve?: unknown }>("cap-widget")
        return Boolean(
          widget &&
            (typeof widget.solve === "function" ||
              widget.shadowRoot?.querySelector(".captcha-trigger, [part=trigger]")),
        )
      })
      .catch(() => false)
    if (found) return true
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())), signal)
  } while (Date.now() < deadline)
  return false
}

export async function solveCap(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  const deadline = Date.now() + timeoutMs
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  try {
    // Let the installed component perform its own PoW and redeem it through the
    // existing browser context. Never submit the surrounding business form.
    const started = await page
      .evaluate(() => {
        type Api = { solve?: () => Promise<unknown>; tokenValue?: string }
        type Widget = HTMLElement & Api
        const widget = Array.from(document.querySelectorAll<Widget>("cap-widget")).find(
          (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
        )
        if (!widget) return false
        const api = widget
        if (typeof api.tokenValue === "string" && api.tokenValue.length > 0) return true
        if (typeof api.solve === "function") {
          void api.solve().catch(() => {})
          return true
        }
        // Firefox's isolated evaluation world may not expose component methods.
        // Its provider-owned shadow control remains accessible through the DOM.
        const trigger = widget.shadowRoot?.querySelector<HTMLElement>(".captcha-trigger, [part=trigger]")
        if (!trigger || trigger.hasAttribute("disabled")) return false
        trigger.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
        const box = trigger.getBoundingClientRect()
        return box.width > 0 && box.height > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : false
      })
      .catch(() => false)
    if (!started) return false
    if (typeof started === "object") await page.mouse.click(started.x, started.y)
    while (Date.now() < deadline && !signal.aborted) {
      const verified = await page
        .evaluate(() => {
          const widgets = document.querySelectorAll<HTMLElement & { tokenValue?: string }>("cap-widget")
          return Array.from(widgets).some((widget) => {
            if (widget.getBoundingClientRect().width <= 0 || widget.getBoundingClientRect().height <= 0) return false
            const name = widget.getAttribute("data-cap-hidden-field-name") ?? "cap-token"
            const field = Array.from(widget.querySelectorAll<HTMLInputElement>("input[type='hidden']")).find(
              (el) => el.name === name,
            )
            const token = widget.tokenValue || field?.value
            return typeof token === "string" && token.length > 0
          })
        })
        .catch(() => false)
      if (verified) return true
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())), signal)
    }
  } catch {
    // A navigation, failed component request or spent budget is not a solution.
  }
  return false
}
