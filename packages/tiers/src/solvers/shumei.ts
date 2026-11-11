import type { Page } from "patchright"
import { sleep } from "../utils/deadline"
import { analyzeClickCaptcha, MAX_SHUMEI_PIXELS } from "./shumeiImage"

const WIDGET = ".shumei_captcha_wrapper"
const IMAGE = ".shumei_captcha_loaded_img_bg"

async function widgetState(page: Page) {
  return page
    .evaluate(
      ({ widget, image }) => {
        const roots = [...document.querySelectorAll<HTMLElement>(widget)].filter(
          (el) => !el.closest("template,noscript"),
        )
        if (roots.length !== 1) return
        const root = roots[0]
        if (!root.classList.contains("mode-spatial_select")) return
        const visible = root.getBoundingClientRect().width > 0 && getComputedStyle(root).visibility !== "hidden"
        const img = root.querySelector<HTMLImageElement>(image)
        const box = img?.getBoundingClientRect()
        return {
          id: root.id,
          visible,
          verified: Boolean(root.querySelector(".shumei_captcha_slide_wrapper.select_success")),
          src: img?.currentSrc || img?.src,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
          x: box?.x ?? 0,
          y: box?.y ?? 0,
          loaded: Boolean(img?.complete && img.naturalWidth > 0),
          prompt: root.querySelector(".shumei_captcha_slide_tips")?.textContent?.trim() ?? "",
        }
      },
      { widget: WIDGET, image: IMAGE },
    )
    .catch(() => undefined)
}

export async function hasShumeiWidget(page: Page, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    if (signal?.aborted) return false
    const state = await widgetState(page)
    if (state?.visible) return true
    const initializing = await page
      .evaluate((widget) => {
        const roots = [...document.querySelectorAll(widget)]
        if (
          roots.length > 1 ||
          roots.some((root) => /\bmode-(?:slide|auto_slide|select|icon_select|seq_select)\b/.test(root.className))
        )
          return false
        return [...document.scripts].some(
          (script) =>
            /\/smcp(?:\.min)?\.js(?:[?#]|$)/i.test(script.src) || /\binitSMCaptcha\s*\(/.test(script.textContent ?? ""),
        )
      }, WIDGET)
      .catch(() => false)
    if (!initializing || Date.now() >= deadline) return false
    await sleep(Math.min(150, deadline - Date.now()), signal).catch(() => {})
  } while (Date.now() < deadline)
  return false
}

export async function solveShumei(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  try {
    if (!(await hasShumeiWidget(page, Math.min(3000, remaining()), signal))) return false
    const initial = await widgetState(page)
    if (!initial || signal.aborted || remaining() <= 0) return false
    if (initial.verified) return true

    for (let attempt = 0; attempt < 3 && remaining() > 0 && !signal.aborted; attempt++) {
      let state = await widgetState(page)
      while (state?.visible && !state.loaded && remaining() > 0 && !signal.aborted) {
        await sleep(Math.min(100, remaining()), signal)
        state = await widgetState(page)
      }
      if (!state?.visible || !state.loaded || state.id !== initial.id || signal.aborted) return false
      const image = page.locator(`${WIDGET} ${IMAGE}`)
      await image.scrollIntoViewIfNeeded({ timeout: Math.max(1, Math.min(1000, remaining())) })
      state = await widgetState(page)
      if (!state?.visible || signal.aborted || remaining() <= 0 || state.id !== initial.id) return false
      if (
        state.width < 1 ||
        state.height < 1 ||
        state.width > 1024 ||
        state.height > 512 ||
        state.width * state.height > MAX_SHUMEI_PIXELS
      )
        return false
      // A fixed region prevents layout growth from expanding the screenshot allocation.
      const png = await page.screenshot({
        clip: { x: state.x, y: state.y, width: state.width, height: state.height },
        type: "png",
        timeout: Math.max(1, Math.min(1500, remaining())),
        scale: "css",
      })
      if (signal.aborted || png.length < 24 || png.length > 2_000_000) return false
      const width = png.readUInt32BE(16),
        height = png.readUInt32BE(20)
      if (!width || !height || width * height > MAX_SHUMEI_PIXELS) return false
      const { PNG } = await import("pngjs")
      const decoded = PNG.sync.read(png)
      const target = analyzeClickCaptcha(decoded.data, decoded.width, decoded.height, [state.prompt]).target
      if (!target || signal.aborted || remaining() <= 0) return false
      const current = await widgetState(page)
      if (!current?.visible || current.id !== initial.id || signal.aborted || remaining() <= 0) return false
      if (current.src !== state.src || current.prompt !== state.prompt) continue
      await image.click({
        timeout: Math.max(1, Math.min(1000, remaining())),
        position: { x: (target.bx * current.width) / decoded.width, y: (target.by * current.height) / decoded.height },
      })

      const resultUntil = Math.min(deadline, Date.now() + 4000)
      while (Date.now() < resultUntil && !signal.aborted) {
        const result = await widgetState(page)
        if (!result || result.id !== initial.id || signal.aborted || remaining() <= 0) return false
        // Only the original SDK's accepted state counts; closing a popup is not success.
        if (result.verified) return true
        if (!result.visible) return false
        if (result.loaded && result.src !== state.src) break
        await sleep(Math.min(100, resultUntil - Date.now()), signal)
      }
    }
  } catch (err) {
    if (!signal.aborted) console.log("[shumei] error:", err instanceof Error ? err.message : err)
  }
  return false
}
