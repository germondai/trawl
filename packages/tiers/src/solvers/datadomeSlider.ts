// DataDome CAPTCHA solver (slider).
//
// The wall's default control is a handle that is dragged along a short track onto a target box.
// The solver does what a person does: it moves the real mouse to the handle, presses, drags with a
// human-shaped path and releases over the target, so DataDome's own script records the gesture and
// builds its own request. Nothing is forged. The image-puzzle variant (a gap to find in a picture)
// is not handled here: the caller falls back to the audio alternative.

import type { Frame, Page } from "patchright"
import { sleep } from "../utils/deadline"
import { accepted, findFrame, hasWallFrame, isRestricted, present, settledAfterAccept } from "./datadomeWidget"

export const SLIDER_HANDLE = "#captcha__element div.slider"
const TARGET = "#captcha__element div.sliderTarget"
const PUZZLE_CANVAS = "#captcha__puzzle canvas"

const MAX_ATTEMPTS = 2

export type SliderResult = "passed" | "restricted" | "failed"

export interface SliderPace {
  // Milliseconds [min, max].
  approach: [number, number]
  hover: [number, number]
  hold: [number, number]
  drag: [number, number]
  release: [number, number]
  // How long to watch the widget after it flags a pass.
  settle: number
  // How long to wait for a verdict after releasing, and how long before a handle that is back
  // at the start counts as a rejected drag.
  verdict: number
  snapBack: number
}

export const HUMAN_SLIDER_PACE: SliderPace = {
  approach: [350, 800],
  hover: [120, 380],
  hold: [90, 240],
  drag: [900, 1800],
  release: [80, 220],
  settle: 6000,
  verdict: 6000,
  snapBack: 1500,
}

export interface Point {
  x: number
  y: number
}

export interface Step extends Point {
  // Pause after moving to this point, in milliseconds.
  dt: number
}

type Random = () => number

function between([min, max]: [number, number], random: Random): number {
  return min + random() * Math.max(0, max - min)
}

// Minimum-jerk profile: starts and ends at rest, fastest in the middle, like a reaching hand.
function minimumJerk(t: number): number {
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5
}

// A path from `from` to `to` over about `durationMs`. The pointer overshoots a little and
// corrects, wobbles off the straight line, and its samples are unevenly spaced. The wobble is
// scaled to zero at both ends so the path starts at `from` and finishes exactly on `to`.
export function humanPath(
  from: Point,
  to: Point,
  durationMs: number,
  random: Random = Math.random,
  { overshoot = true, wobble = 3 }: { overshoot?: boolean; wobble?: number } = {},
): Step[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length < 1) return [{ ...to, dt: 0 }]

  const count = Math.max(12, Math.round((durationMs / 16) * (0.6 + random() * 0.6)))
  // Unevenly spaced timestamps, sorted, so the speed profile is not perfectly smooth.
  const times = Array.from({ length: count }, () => random()).sort((a, b) => a - b)
  const phases = [random() * Math.PI * 2, random() * Math.PI * 2]
  const over = overshoot && length > 40 ? 3 + random() * 5 : 0
  const settleAt = over > 0 ? 0.88 : 1

  const steps: Step[] = []
  let previous = 0
  times.forEach((t, i) => {
    const last = i === count - 1
    const u = last ? 1 : t
    // Phase one runs past the target, phase two eases back onto it.
    const along =
      u <= settleAt
        ? (length + over) * minimumJerk(u / settleAt)
        : length + over * (1 - minimumJerk((u - settleAt) / (1 - settleAt)))
    const progress = Math.min(1, along / length)
    const fade = Math.sin(Math.PI * Math.min(1, progress))
    const noise = wobble * fade * (Math.sin(u * 7 + phases[0]) * 0.6 + Math.sin(u * 17 + phases[1]) * 0.4)
    const x = from.x + (dx / length) * along + (-dy / length) * noise
    const y = from.y + (dy / length) * along + (dx / length) * noise
    steps.push({ x: last ? to.x : x, y: last ? to.y : y, dt: Math.max(0, (u - previous) * durationMs) })
    previous = u
  })
  return steps
}

async function puzzleVisible(frame: Frame): Promise<boolean> {
  try {
    return await frame.evaluate((selector) => {
      for (const canvas of document.querySelectorAll(selector)) {
        if (canvas.getBoundingClientRect().height > 0) return true
      }
      return false
    }, PUZZLE_CANVAS)
  } catch {
    return false
  }
}

async function boxOf(frame: Frame, selector: string, timeout: number) {
  return frame
    .locator(selector)
    .first()
    .boundingBox({ timeout })
    .catch(() => null)
}

export async function solveDataDomeSlider(
  page: Page,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  pace: SliderPace = HUMAN_SLIDER_PACE,
  random: Random = Math.random,
): Promise<SliderResult> {
  if (timeoutMs <= 0 || signal?.aborted) return "failed"
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  const wait = (ms: number) => sleep(Math.min(ms, remaining()), signal).catch(() => {})

  try {
    console.log(`[datadome] slider: starting with ${Math.round(remaining() / 1000)}s`)
    let frame = await findFrame(page, [SLIDER_HANDLE])
    if (!frame) {
      console.log("[datadome] slider: no handle in the wall")
      return "failed"
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal.aborted || remaining() <= 0) {
        console.log("[datadome] slider: out of time before attempt", attempt + 1)
        return "failed"
      }
      if (await accepted(frame)) {
        console.log("[datadome] slider: the wall was already flagged as passed")
        return await settledAfterAccept(page, frame, pace.settle, signal, remaining)
      }
      if (await isRestricted(frame)) {
        console.log("[datadome] slider: the wall was already restricted")
        return "restricted"
      }
      if (await puzzleVisible(frame)) {
        console.log("[datadome] slider: image puzzle variant, leaving it to the audio alternative")
        return "failed"
      }

      const handle = await boxOf(frame, SLIDER_HANDLE, Math.max(1, Math.min(3000, remaining())))
      const target = await boxOf(frame, TARGET, Math.max(1, Math.min(3000, remaining())))
      if (!handle || !target) {
        console.log(`[datadome] slider: could not measure the ${handle ? "target" : "handle"}`)
        return "failed"
      }

      // Grab the handle somewhere inside it, not always dead centre.
      const grab: Point = {
        x: handle.x + handle.width * (0.35 + random() * 0.3),
        y: handle.y + handle.height * (0.3 + random() * 0.4),
      }
      // Release with the handle over the target: shift by how far the target sits from the handle.
      const travel = target.x + target.width / 2 - (handle.x + handle.width / 2)
      const drop: Point = { x: grab.x + travel, y: grab.y + (random() - 0.5) * 6 }
      // The pointer arrives from somewhere else on the page.
      const origin: Point = {
        x: grab.x - (80 + random() * 160),
        y: grab.y + (random() < 0.5 ? -1 : 1) * (30 + random() * 70),
      }

      const startedAt = Date.now()
      const mark = (what: string) => console.log(`[datadome] slider: ${what} +${Date.now() - startedAt}ms`)
      console.log(
        `[datadome] slider: handle ${Math.round(handle.x)},${Math.round(handle.y)} target ${Math.round(target.x)},${Math.round(target.y)}`,
      )
      let pressed = false
      try {
        for (const step of humanPath(origin, grab, between(pace.approach, random), random, {
          overshoot: false,
          wobble: 6,
        })) {
          if (signal.aborted) return "failed"
          await page.mouse.move(step.x, step.y, { steps: 1 })
          await wait(step.dt)
        }
        await wait(between(pace.hover, random))
        mark("approached")
        await page.mouse.down()
        pressed = true
        await wait(between(pace.hold, random))
        for (const step of humanPath(grab, drop, between(pace.drag, random), random)) {
          if (signal.aborted) return "failed"
          await page.mouse.move(step.x, step.y, { steps: 1 })
          await wait(step.dt)
        }
        mark("dragged")
        await wait(between(pace.release, random))
      } finally {
        // Never leave the button held: a held press would swallow every later click on the page.
        if (pressed) await page.mouse.up().catch(() => {})
      }

      const verdictStart = Date.now()
      const verdictBy = Math.min(deadline, verdictStart + pace.verdict)
      while (Date.now() < verdictBy && !signal.aborted) {
        if (await accepted(frame)) {
          const verdict = await settledAfterAccept(page, frame, pace.settle, signal, remaining)
          console.log(
            `[datadome] slider ${verdict === "passed" ? "accepted" : "turned away"} after ${attempt + 1} attempt(s)`,
          )
          return verdict
        }
        if (await isRestricted(frame)) {
          console.log(`[datadome] slider turned away after ${attempt + 1} attempt(s): access restricted`)
          return "restricted"
        }
        if (frame.isDetached()) {
          // The page left the wall, or DataDome swapped in another wall page: a new puzzle, or the
          // restricted page. Only the first one is a pass.
          const next = await findFrame(page, [SLIDER_HANDLE])
          if (!next) {
            if (!hasWallFrame(page)) return "passed"
            console.log(`[datadome] slider turned away after ${attempt + 1} attempt(s): access restricted`)
            return "restricted"
          }
          frame = next
          break
        }
        // A rejected drag snaps the handle back to the start and the widget stays: try again.
        if (await present(frame, SLIDER_HANDLE)) {
          const back = await boxOf(frame, SLIDER_HANDLE, 500)
          if (back && Math.abs(back.x - handle.x) < 4 && Date.now() - verdictStart > pace.snapBack) break
        }
        await wait(250)
      }
    }
    console.log("[datadome] slider gave up")
  } catch (err) {
    if (!signal?.aborted) console.log("[datadome] slider error:", err instanceof Error ? err.message : err)
  }
  return "failed"
}
