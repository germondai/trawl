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
    while (Date.now() < deadline && !signal.aborted) {
      const started = await page
        .evaluate(() => {
          type Widget = HTMLElement & { solve?: () => Promise<unknown>; tokenValue?: string }
          const widgets = Array.from(document.querySelectorAll<Widget>("cap-widget"))
          const visible = widgets.filter((el) => {
            const box = el.getBoundingClientRect()
            return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"
          })
          if (!visible.length) return false
          const widget = visible.find((el) => {
            const name = el.getAttribute("data-cap-hidden-field-name") ?? "cap-token"
            const field = Array.from(el.querySelectorAll<HTMLInputElement>("input[type='hidden']")).find(
              (input) => input.name === name,
            )
            const token = el.tokenValue || field?.value
            return typeof token !== "string" || token.length === 0
          })
          if (!widget) return true
          const index = widgets.indexOf(widget)
          if (typeof widget.solve === "function") {
            void widget.solve().catch(() => {})
            return { index }
          }
          // Firefox may hide component methods in its isolated evaluation world.
          const trigger = widget.shadowRoot?.querySelector<HTMLElement>(".captcha-trigger, [part=trigger]")
          if (!trigger || trigger.hasAttribute("disabled")) return false
          trigger.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
          const box = trigger.getBoundingClientRect()
          return box.width > 0 && box.height > 0
            ? { index, x: box.x + box.width / 2, y: box.y + box.height / 2 }
            : false
        })
        .catch(() => false)
      if (started === true) return true
      if (!started) return false
      if (typeof started.x === "number" && typeof started.y === "number") await page.mouse.click(started.x, started.y)
      // Solve sequentially so multiple PoW widgets do not multiply worker usage.
      while (Date.now() < deadline && !signal.aborted) {
        const verified = await page
          .evaluate((index) => {
            const widget = document.querySelectorAll<HTMLElement & { tokenValue?: string }>("cap-widget")[index]
            if (!widget) return false
            const name = widget.getAttribute("data-cap-hidden-field-name") ?? "cap-token"
            const field = Array.from(widget.querySelectorAll<HTMLInputElement>("input[type='hidden']")).find(
              (el) => el.name === name,
            )
            const token = widget.tokenValue || field?.value
            return typeof token === "string" && token.length > 0
          }, started.index)
          .catch(() => false)
        if (verified) break
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())), signal)
      }
    }
  } catch {
    // A navigation, failed component request or spent budget is not a solution.
  }
  return false
}
