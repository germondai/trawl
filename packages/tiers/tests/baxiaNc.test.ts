import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { hasBaxiaNcMarkup, hasBaxiaNcWidget, planNcDrag, solveBaxiaNc } from "../src/solvers/baxiaNc"

const FAST = { appearMs: 300, resultMs: 400, retryMs: 400 }
const KNOB = { x: 100, y: 200, width: 40, height: 40 }
const TRACK = { x: 100, y: 200, width: 300, height: 40 }

describe("Baxia NC detection", () => {
  test("recognises the punish page and the NC script", () => {
    expect(hasBaxiaNcMarkup('<iframe src="https://x.test/_____tmd_____/punish?x5secdata=a"></iframe>')).toBe(true)
    expect(hasBaxiaNcMarkup('<script src="https://g.alicdn.com/AWSC/nc/1.97.2/nc.js"></script>')).toBe(true)
    expect(hasBaxiaNcMarkup('<span id="nc_1_n1z" class="btn_slide"></span>')).toBe(true)
    expect(hasBaxiaNcMarkup('<script src="https://cf.aliyun.com/nocaptcha/initialize.jsonp?a=x"></script>')).toBe(true)
  })

  test("ignores unrelated pages and look-alike ids", () => {
    expect(hasBaxiaNcMarkup("<html><body>hello</body></html>")).toBe(false)
    expect(hasBaxiaNcMarkup('<div id="nc_1_n1zz"></div>')).toBe(false)
    expect(hasBaxiaNcMarkup('<script src="https://example.test/nc.js"></script>')).toBe(false)
  })
})

describe("NC drag plan", () => {
  test("the knob's centre travels the track minus the knob and the drag overshoots then settles", () => {
    for (let i = 0; i < 50; i++) {
      const plan = planNcDrag(KNOB, TRACK)
      expect(plan.press).toEqual({ x: 120, y: 220 })
      expect(plan.release.x).toBeCloseTo(120 + 260, 5)
      expect(plan.overshoot.x).toBeGreaterThan(plan.release.x)
      expect(plan.overshoot.x).toBeLessThanOrEqual(120 + 260 * 1.12 + 1e-9)
      expect(plan.start.x).toBeLessThan(plan.press.x)
      expect(plan.start.y).toBeGreaterThan(plan.press.y)
      expect(plan.pauses.hover).toBeGreaterThanOrEqual(80)
      expect(plan.pauses.held).toBeLessThanOrEqual(200)
    }
  })

  test("is deterministic for a given random source and never has a zero-length span", () => {
    const fixed = () => 0.5
    expect(planNcDrag(KNOB, TRACK, fixed)).toEqual(planNcDrag(KNOB, TRACK, fixed))
    const degenerate = planNcDrag({ ...KNOB, width: 50 }, { ...TRACK, width: 40 }, fixed)
    expect(degenerate.release.x).toBeGreaterThan(degenerate.press.x)
  })
})

interface FakeOptions {
  // Which drag (1-based) makes the server issue a clearance cookie; none when undefined.
  passOnDrag?: number
  existingCookie?: string
  hasWidget?: boolean
  hasRetry?: boolean
  knobHomesOnRetry?: boolean
}

function fakePage(options: FakeOptions = {}) {
  const { hasWidget = true, hasRetry = true, knobHomesOnRetry = true } = options
  const log: string[] = []
  const cookies: { name: string; value: string; domain: string; path: string }[] = options.existingCookie
    ? [{ name: "x5sec", value: options.existingCookie, domain: ".example.test", path: "/" }]
    : []
  let drags = 0
  let knobX = KNOB.x
  const locator = (selector: string) => {
    const first = {
      boundingBox: async () => {
        if (!hasWidget) return null
        if (selector === "#nc_1_n1z") return { ...KNOB, x: knobX }
        if (selector === "#nc_1_n1t") return TRACK
        return null
      },
      isVisible: async () => hasRetry && selector.includes("refresh"),
      click: async () => {
        log.push("retry")
        if (knobHomesOnRetry) knobX = KNOB.x
      },
    }
    return { first: () => first }
  }
  const frame = { locator }
  const page = {
    frames: () => [frame],
    context: () => ({ cookies: async () => cookies }),
    isClosed: () => false,
    mouse: {
      move: async (x: number, y: number) => void log.push(`move ${Math.round(x)},${Math.round(y)}`),
      down: async () => void log.push("down"),
      up: async () => {
        log.push("up")
        drags++
        knobX = KNOB.x + 260
        if (options.passOnDrag === drags) {
          cookies.push({ name: "x5sec", value: `issued-${drags}`, domain: ".example.test", path: "/" })
        }
      },
    },
  }
  return { page: page as unknown as Page, log, drags: () => drags }
}

describe("solveBaxiaNc", () => {
  test("passes when the first slide issues a new x5sec", async () => {
    const fake = fakePage({ passOnDrag: 1 })
    expect(await solveBaxiaNc(fake.page, 5000, undefined, FAST)).toBe(true)
    expect(fake.drags()).toBe(1)
    // Pointer goes down on the knob and comes back up once, with the long moves in between.
    expect(fake.log.filter((entry) => entry === "down")).toHaveLength(1)
    expect(fake.log.at(-1)).toBe("up")
    expect(fake.log.some((entry) => entry.startsWith("move 380,"))).toBe(true)
  })

  test("uses the widget's own retry after a rejected slide and passes on the next", async () => {
    const fake = fakePage({ passOnDrag: 2 })
    expect(await solveBaxiaNc(fake.page, 5000, undefined, FAST)).toBe(true)
    expect(fake.drags()).toBe(2)
    expect(fake.log).toContain("retry")
  })

  test("a clearance cookie that was already present does not count as passing", async () => {
    const fake = fakePage({ existingCookie: "old", hasRetry: false })
    expect(await solveBaxiaNc(fake.page, 5000, undefined, FAST)).toBe(false)
    expect(fake.drags()).toBe(1)
  })

  test("gives up after three rejected slides", async () => {
    const fake = fakePage({})
    expect(await solveBaxiaNc(fake.page, 8000, undefined, FAST)).toBe(false)
    expect(fake.drags()).toBe(3)
  })

  test("stops when the retry control is missing or the knob never returns", async () => {
    const noRetry = fakePage({ hasRetry: false })
    expect(await solveBaxiaNc(noRetry.page, 5000, undefined, FAST)).toBe(false)
    expect(noRetry.drags()).toBe(1)
    const stuck = fakePage({ knobHomesOnRetry: false })
    expect(await solveBaxiaNc(stuck.page, 5000, undefined, FAST)).toBe(false)
    expect(stuck.drags()).toBe(1)
  })

  test("does nothing when the page has no NC widget", async () => {
    const fake = fakePage({ hasWidget: false })
    expect(await hasBaxiaNcWidget(fake.page, 100)).toBe(false)
    expect(await solveBaxiaNc(fake.page, 1000, undefined, FAST)).toBe(false)
    expect(fake.log).toEqual([])
  })

  test("respects an aborted signal and a zero budget", async () => {
    const aborted = fakePage({ passOnDrag: 1 })
    expect(await solveBaxiaNc(aborted.page, 5000, AbortSignal.abort(), FAST)).toBe(false)
    expect(aborted.log).toEqual([])
    const none = fakePage({ passOnDrag: 1 })
    expect(await solveBaxiaNc(none.page, 0, undefined, FAST)).toBe(false)
    expect(none.log).toEqual([])
  })
})
