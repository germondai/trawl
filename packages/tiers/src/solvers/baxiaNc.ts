// Alibaba Baxia "slide to verify" (NC / NoCaptcha) solver.
//
// Baxia answers a flagged request with a punish page (`.../_____tmd_____/punish`) whose
// widget is a plain slider: drag the knob to the end of the track. Passing it makes the
// server issue the `x5sec` cookie, which is the clearance itself. A failed slide issues
// none, so success is only ever a new, non-empty `x5sec`; the widget's own "verified" text
// and the challenge's beacon traffic (`/_____tmd_____/report`) answer 2xx either way and
// prove nothing.
//
// The widget lives in the punish document or in an iframe of it, so every frame is checked.
// Camoufox is launched with `humanize`, which animates each pointer move, so the drag is a
// few long moves rather than many short ones (subdividing it would repeat the animation).

import type { Frame, Page } from "patchright"
import { sleep } from "../utils/deadline"

const KNOB = "#nc_1_n1z"
const TRACK = "#nc_1_n1t"
const RETRY = "#nc_1_refresh1, #nc_1_refresh2, .nc_iconfont.btn_refresh, .errloading"
const CLEARANCE_COOKIE = "x5sec"

const MAX_ATTEMPTS = 3
// The widget's iframe loads after the punish document itself.
const APPEAR_MS = 12_000
const RESULT_MS = 8_000
const RETRY_MS = 5_000

// Injectable so the retry loop can be exercised without waiting out real delays.
export interface NcTiming {
  appearMs: number
  resultMs: number
  retryMs: number
}
const TIMING: NcTiming = { appearMs: APPEAR_MS, resultMs: RESULT_MS, retryMs: RETRY_MS }

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface NcDragPlan {
  /** Where the pointer first appears, off the knob to the lower left. */
  start: { x: number; y: number }
  /** The knob's centre, where the button goes down. */
  press: { x: number; y: number }
  /** Past the end of the track. Landing exactly on it in one pass reads as a machine. */
  overshoot: { x: number; y: number }
  /** The end of the track, where the button comes up. */
  release: { x: number; y: number }
  /** Milliseconds to wait before pressing, after pressing and before releasing. */
  pauses: { hover: number; held: number; settle: number }
}

// Whether the page carries Alibaba's NC widget. Markup only: the knob exists once the
// scripts run, which `hasBaxiaNcWidget` waits for.
export function hasBaxiaNcMarkup(html: string): boolean {
  return /_____tmd_____\/punish|\bnc_1_n1[zt]\b|AWSC\/nc\/[\d.]+\/nc\.js|cf\.aliyun\.com\/nocaptcha/i.test(html)
}

// The knob's centre can travel the track minus the knob. Pure, so the geometry is testable
// without a browser; `random` is injectable for the same reason.
export function planNcDrag(knob: Box, track: Box, random: () => number = Math.random): NcDragPlan {
  const between = (low: number, high: number) => low + random() * (high - low)
  const x = knob.x + knob.width / 2
  const y = knob.y + knob.height / 2
  const span = Math.max(1, track.width - knob.width)
  return {
    start: { x: x - between(15, 30), y: y + between(8, 22) },
    press: { x, y },
    overshoot: { x: x + span * between(1.02, 1.12), y: y + between(1, 3) },
    release: { x: x + span, y: y + between(-0.5, 0.5) },
    pauses: { hover: between(80, 200), held: between(80, 200), settle: between(20, 80) },
  }
}

async function boxOf(frame: Frame, selector: string): Promise<Box | undefined> {
  const box = await frame
    .locator(selector)
    .first()
    .boundingBox({ timeout: 300 })
    .catch(() => null)
  return box ?? undefined
}

// The knob and track, in whichever frame holds them. Playwright reports both in the page's
// own coordinates, so the mouse needs no frame offset.
async function ncSlider(page: Page): Promise<{ knob: Box; track: Box; frame: Frame } | undefined> {
  for (const frame of page.frames()) {
    const knob = await boxOf(frame, KNOB)
    const track = knob ? await boxOf(frame, TRACK) : undefined
    if (knob && track && track.width > 0 && knob.width > 0) return { knob, track, frame }
  }
}

export async function hasBaxiaNcWidget(page: Page, timeoutMs = APPEAR_MS, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    if (signal?.aborted) return false
    if (await ncSlider(page)) return true
    if (Date.now() >= deadline) break
    await sleep(Math.min(250, deadline - Date.now()), signal).catch(() => {})
  } while (Date.now() < deadline)
  return false
}

async function clearance(page: Page): Promise<Map<string, string>> {
  const cookies = await page
    .context()
    .cookies()
    .catch(() => [])
  const values = new Map<string, string>()
  for (const cookie of cookies) {
    if (cookie.name === CLEARANCE_COOKIE && cookie.value) values.set(`${cookie.domain}|${cookie.path}`, cookie.value)
  }
  return values
}

// A cookie that was already there never counts as this slide passing.
function issued(before: Map<string, string>, now: Map<string, string>): boolean {
  for (const [key, value] of now) if (before.get(key) !== value) return true
  return false
}

async function drag(page: Page, plan: NcDragPlan, signal: AbortSignal): Promise<void> {
  const { mouse } = page
  await mouse.move(plan.start.x, plan.start.y)
  await sleep(plan.pauses.hover, signal)
  await mouse.move(plan.press.x, plan.press.y)
  await mouse.down()
  try {
    await sleep(plan.pauses.held, signal)
    await mouse.move(plan.overshoot.x, plan.overshoot.y)
    await mouse.move(plan.release.x, plan.release.y)
    await sleep(plan.pauses.settle, signal)
  } finally {
    await mouse.up().catch(() => {})
  }
}

// Use the widget's own retry rather than reloading: a reload opens a new verification session.
async function retry(
  page: Page,
  home: number,
  deadline: number,
  signal: AbortSignal,
  retryMs: number,
): Promise<boolean> {
  let clicked = false
  for (const frame of page.frames()) {
    const link = frame.locator(RETRY).first()
    if (await link.isVisible({ timeout: 200 }).catch(() => false)) {
      clicked = await link
        .click({ timeout: 1500 })
        .then(() => true)
        .catch(() => false)
      if (clicked) break
    }
  }
  if (!clicked) return false
  const until = Math.min(deadline, Date.now() + retryMs)
  while (Date.now() < until && !signal.aborted) {
    const found = await ncSlider(page)
    if (found && Math.abs(found.knob.x - home) <= 3) return true
    await sleep(250, signal).catch(() => {})
  }
  return false
}

export async function solveBaxiaNc(
  page: Page,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  timing: Partial<NcTiming> = {},
): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  const { appearMs, resultMs, retryMs } = { ...TIMING, ...timing }
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs
  try {
    if (!(await hasBaxiaNcWidget(page, Math.min(appearMs, timeoutMs), signal))) return false
    const first = await ncSlider(page)
    if (!first) return false
    const home = first.knob.x

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && Date.now() < deadline && !signal.aborted; attempt++) {
      const found = await ncSlider(page)
      if (!found) return false
      const before = await clearance(page)
      console.log(`[baxia-nc] attempt ${attempt}/${MAX_ATTEMPTS}`)
      await drag(page, planNcDrag(found.knob, found.track), signal)

      const resultUntil = Math.min(deadline, Date.now() + resultMs)
      while (Date.now() < resultUntil && !signal.aborted) {
        if (issued(before, await clearance(page))) {
          console.log(`[baxia-nc] passed on attempt ${attempt}`)
          return true
        }
        if (page.isClosed()) return false
        await sleep(250, signal).catch(() => {})
      }
      if (attempt === MAX_ATTEMPTS || !(await retry(page, home, deadline, signal, retryMs))) break
    }
  } catch (err) {
    if (!signal.aborted) console.log("[baxia-nc] error:", err instanceof Error ? err.message : err)
  }
  return false
}
