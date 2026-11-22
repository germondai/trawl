import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { humanPath, type SliderPace, solveDataDomeSlider } from "../src/solvers/datadomeSlider"

const HANDLE = "#captcha__element div.slider"
const TARGET = "#captcha__element div.sliderTarget"
const PASSED = '#analyticsCaptchaPassed[data-analytics-captcha-passed="true"]'

const HANDLE_BOX = { x: 820, y: 476, width: 63, height: 40 }
const TARGET_BOX = { x: 1042, y: 476, width: 63, height: 40 }

// No pauses, short verdict waits: the pacing is a human-likeness concern, not loop logic.
const FAST: SliderPace = {
  approach: [0, 0],
  hover: [0, 0],
  hold: [0, 0],
  drag: [0, 0],
  release: [0, 0],
  settle: 0,
  verdict: 300,
  snapBack: 60,
}

// A small deterministic generator so the shape of a path can be asserted.
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Outcome = "accept" | "reject" | "restricted-inline" | "swapped" | "gone"

// A scripted stand-in for the wall: the handle is dragged with the mouse and each release over
// the target is answered from a list of outcomes. A release anywhere else is a miss.
function fakeSlider(
  options: { outcomes?: Outcome[]; puzzle?: boolean; handle?: boolean; onMove?: (moves: number) => void } = {},
) {
  const events: string[] = []
  const moves: Array<{ x: number; y: number }> = []
  const outcomes = [...(options.outcomes ?? ["accept"])]
  const state = { pressed: false, passed: false, inline: false, detached: false, swapped: false }

  const mouse = {
    move: async (x: number, y: number) => {
      events.push("move")
      moves.push({ x, y })
      options.onMove?.(moves.length)
    },
    down: async () => {
      events.push("down")
      state.pressed = true
    },
    up: async () => {
      events.push("up")
      state.pressed = false
      const last = moves[moves.length - 1]
      const targetCentre = TARGET_BOX.x + TARGET_BOX.width / 2
      if (!last || Math.abs(last.x - targetCentre) > TARGET_BOX.width / 2) return
      const outcome = outcomes.shift() ?? "reject"
      if (outcome === "accept") state.passed = true
      if (outcome === "restricted-inline") {
        state.passed = true
        state.inline = true
      }
      if (outcome === "swapped") {
        state.passed = true
        state.detached = true
        state.swapped = true
      }
      if (outcome === "gone") state.detached = true
    },
  }

  const boxes: Record<string, typeof HANDLE_BOX> = { [HANDLE]: HANDLE_BOX, [TARGET]: TARGET_BOX }
  const locator = (selector: string): unknown => ({
    first: () => locator(selector),
    isVisible: async () => options.handle !== false && selector === HANDLE,
    boundingBox: async () => boxes[selector] ?? null,
    count: async () => (selector === PASSED && state.passed ? 1 : 0),
    textContent: async () => (state.inline ? "O acesso está temporariamente restrito" : "Deslize para a direita"),
  })

  const frame = {
    locator,
    isDetached: () => state.detached,
    evaluate: async () => options.puzzle === true,
    url: () => "https://geo.captcha-delivery.com/captcha/",
  }
  const idle = (url: string) => ({
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    url: () => url,
  })
  // What DataDome puts in the replacement iframe once it has turned an answer away.
  const restrictedWall = {
    locator: () => ({
      first: () => ({ isVisible: async () => false }),
      textContent: async () => "O acesso está temporariamente restrito",
    }),
    isDetached: () => false,
    url: () => "https://geo.captcha-delivery.com/captcha/",
  }
  const page = {
    mouse,
    frames: () =>
      state.detached
        ? [idle("https://www.thefork.com/"), ...(state.swapped ? [restrictedWall] : [])]
        : [idle("https://www.thefork.com/"), frame],
  } as unknown as Page

  return { page, events, moves, state }
}

describe("humanPath", () => {
  const from = { x: 100, y: 200 }
  const to = { x: 320, y: 204 }

  test("starts at the origin's neighbourhood and finishes exactly on the target", () => {
    const steps = humanPath(from, to, 1200, seeded(1))
    expect(steps.length).toBeGreaterThanOrEqual(12)
    expect(steps.at(-1)?.x).toBe(to.x)
    expect(steps.at(-1)?.y).toBe(to.y)
    expect(Math.abs(steps[0].x - from.x)).toBeLessThan(15)
  })

  test("spends about the requested time and never waits a negative amount", () => {
    const steps = humanPath(from, to, 1200, seeded(2))
    const total = steps.reduce((sum, step) => sum + step.dt, 0)
    expect(total).toBeGreaterThan(900)
    expect(total).toBeLessThanOrEqual(1201)
    expect(steps.every((step) => step.dt >= 0)).toBe(true)
  })

  test("is not a straight line at constant speed: it overshoots, wobbles and varies its pace", () => {
    const steps = humanPath(from, to, 1200, seeded(3))
    expect(Math.max(...steps.map((step) => step.x))).toBeGreaterThan(to.x)
    expect(
      steps.some((step) => Math.abs(step.y - (from.y + (to.y - from.y) * ((step.x - from.x) / (to.x - from.x)))) > 0.5),
    ).toBe(true)
    const gaps = steps.map((step) => step.dt)
    expect(new Set(gaps.map((gap) => Math.round(gap))).size).toBeGreaterThan(3)
  })

  test("keeps the wobble small and the same shape for the same seed", () => {
    const a = humanPath(from, to, 1200, seeded(4), { wobble: 3 })
    const b = humanPath(from, to, 1200, seeded(4), { wobble: 3 })
    expect(a).toEqual(b)
    expect(Math.max(...a.map((step) => Math.abs(step.y - from.y)))).toBeLessThan(20)
  })

  test("a zero-length move is a single step", () => {
    expect(humanPath(from, from, 500, seeded(5))).toEqual([{ ...from, dt: 0 }])
  })

  test("no overshoot when asked not to", () => {
    const steps = humanPath(from, to, 1200, seeded(6), { overshoot: false })
    expect(Math.max(...steps.map((step) => step.x))).toBeLessThanOrEqual(to.x + 4)
  })
})

describe("DataDome slider solver", () => {
  test("drags the handle onto the target and reports the accepted verdict", async () => {
    const widget = fakeSlider()
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("passed")
    expect(widget.events.filter((e) => e === "down")).toHaveLength(1)
    expect(widget.events.filter((e) => e === "up")).toHaveLength(1)
    expect(widget.events.indexOf("down")).toBeLessThan(widget.events.indexOf("up"))
    const drop = widget.moves.at(-1)
    expect(drop && Math.abs(drop.x - (TARGET_BOX.x + TARGET_BOX.width / 2)) <= TARGET_BOX.width / 2).toBe(true)
  })

  test("approaches the handle before pressing", async () => {
    const widget = fakeSlider()
    await solveDataDomeSlider(widget.page, 5000, undefined, FAST)
    expect(widget.events.indexOf("down")).toBeGreaterThan(5)
    // The press happens inside the handle.
    const pressedAt =
      widget.moves[widget.events.slice(0, widget.events.indexOf("down")).filter((e) => e === "move").length - 1]
    expect(pressedAt.x).toBeGreaterThanOrEqual(HANDLE_BOX.x)
    expect(pressedAt.x).toBeLessThanOrEqual(HANDLE_BOX.x + HANDLE_BOX.width)
  })

  test("a rejected drag is retried once, then given up", async () => {
    const widget = fakeSlider({ outcomes: ["reject", "reject"] })
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("failed")
    expect(widget.events.filter((e) => e === "down")).toHaveLength(2)
    expect(widget.events.filter((e) => e === "up")).toHaveLength(2)
  })

  test("a rejection followed by an accepted drag passes", async () => {
    const widget = fakeSlider({ outcomes: ["reject", "accept"] })
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("passed")
    expect(widget.events.filter((e) => e === "down")).toHaveLength(2)
  })

  test("a pass that DataDome turns away in the same frame is restricted, not solved", async () => {
    const widget = fakeSlider({ outcomes: ["restricted-inline"] })
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("restricted")
    expect(widget.events.filter((e) => e === "down")).toHaveLength(1)
  })

  test("a pass whose iframe DataDome replaces with the restricted page is restricted, not solved", async () => {
    const widget = fakeSlider({ outcomes: ["swapped"] })
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("restricted")
  })

  test("the wall leaving the page after the drag is a pass", async () => {
    const widget = fakeSlider({ outcomes: ["gone"] })
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("passed")
  })

  test("never leaves the button held when stopped in the middle of the drag", async () => {
    const controller = new AbortController()
    const widget = fakeSlider({ onMove: (count) => count === 20 && controller.abort() })
    expect(await solveDataDomeSlider(widget.page, 5000, controller.signal, FAST)).toBe("failed")
    const downs = widget.events.filter((e) => e === "down").length
    const ups = widget.events.filter((e) => e === "up").length
    expect(ups).toBe(downs)
    expect(widget.state.pressed).toBe(false)
  })

  test("the image-puzzle variant is left alone without touching the mouse", async () => {
    const widget = fakeSlider({ puzzle: true })
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("failed")
    expect(widget.events).toEqual([])
  })

  test("a wall without a slider handle is not attempted", async () => {
    const widget = fakeSlider({ handle: false })
    expect(await solveDataDomeSlider(widget.page, 5000, undefined, FAST)).toBe("failed")
    expect(widget.events).toEqual([])
  })

  test("returns failed straight away with no time left or an aborted signal", async () => {
    const widget = fakeSlider()
    expect(await solveDataDomeSlider(widget.page, 0, undefined, FAST)).toBe("failed")
    const controller = new AbortController()
    controller.abort()
    expect(await solveDataDomeSlider(widget.page, 5000, controller.signal, FAST)).toBe("failed")
    expect(widget.events).toEqual([])
  })
})
