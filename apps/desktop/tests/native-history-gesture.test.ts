import { expect, test } from "bun:test"
import { createHistoryGesture, type HistoryDirection } from "../app/utils/native-history-gesture"

const wheel = (deltaX: number, deltaY = 0, extra = {}) => ({
  deltaX,
  deltaY,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  ...extra,
})
const allowed = () => false

test("the trackpad signals a reached edge before release and never repeats while held there", () => {
  for (const direction of [-1, 1]) {
    const events: string[] = []
    const gesture = createHistoryGesture({
      enabled: () => true,
      canNavigate: () => true,
      feedback: () => {},
      onThreshold: () => events.push("edge"),
      navigate: (value) => events.push(value),
    })
    gesture.phase("begin")
    gesture.wheel(wheel(direction * 100), allowed)
    expect(events).toEqual([])
    gesture.wheel(wheel(direction * 30), allowed)
    gesture.wheel(wheel(direction * 30), allowed)
    expect(events).toEqual(["edge"])
    gesture.wheel(wheel(-direction * 50), allowed)
    gesture.phase("end")
    expect(events).toEqual(["edge"])
  }
})

test("forward preview progresses and retreats without committing when the swipe is cancelled", () => {
  const progress: [HistoryDirection | null, number][] = []
  const commits: HistoryDirection[] = []
  const gesture = createHistoryGesture({
    enabled: () => true,
    canNavigate: (direction) => direction === "forward",
    feedback: (direction, fraction) => progress.push([direction, fraction]),
    navigate: (direction) => commits.push(direction),
  })
  gesture.phase("begin")
  gesture.wheel(wheel(73), allowed)
  gesture.wheel(wheel(45), allowed)
  gesture.wheel(wheel(-45), allowed)
  gesture.phase("cancel")
  expect(progress).toEqual([
    ["forward", 0.5],
    ["forward", 1],
    ["forward", 0.5],
    [null, 0],
  ])
  expect(commits).toEqual([])
})

function fixture() {
  const navigations: HistoryDirection[] = []
  let enabled = true,
    available = true
  const gesture = createHistoryGesture({
    enabled: () => enabled,
    canNavigate: () => available,
    navigate: (direction) => navigations.push(direction),
    feedback: () => {},
  })
  return {
    gesture,
    navigations,
    enable: () => {
      enabled = true
    },
    disable: () => {
      enabled = false
    },
    unavailable: () => {
      available = false
    },
  }
}

test("trackpad commits once on finger release and consumes the remaining momentum", () => {
  const { gesture, navigations } = fixture()
  gesture.phase("begin")
  expect(gesture.wheel(wheel(-70), allowed)).toBe(true)
  gesture.wheel(wheel(-60), allowed)
  gesture.idle()
  expect(navigations).toEqual([])
  gesture.phase("end")
  expect(navigations).toEqual(["back"])
  gesture.phase("momentum")
  expect(gesture.wheel(wheel(-500), allowed)).toBe(true)
  gesture.phase("momentum-end")
  gesture.idle()
  expect(navigations).toEqual(["back"])
  gesture.phase("begin")
  gesture.wheel(wheel(130), allowed)
  gesture.phase("end")
  expect(navigations).toEqual(["back", "forward"])
})

test("reversing before release, small motions and native cancellation do not navigate", () => {
  for (const cancel of [false, true]) {
    const { gesture, navigations } = fixture()
    gesture.phase("begin")
    gesture.wheel(wheel(-160), allowed)
    if (!cancel) gesture.wheel(wheel(140), allowed)
    gesture.phase(cancel ? "cancel" : "end")
    gesture.wheel(wheel(-500), allowed)
    expect(navigations).toEqual([])
  }
  const { gesture, navigations } = fixture()
  gesture.wheel(wheel(-50), allowed)
  gesture.idle()
  expect(navigations).toEqual([])
})

test("a saturated swipe can return to neutral and cross into the opposite direction", () => {
  const feedback: [HistoryDirection | null, number][] = []
  const navigations: HistoryDirection[] = []
  const gesture = createHistoryGesture({
    enabled: () => true,
    canNavigate: () => true,
    navigate: (direction) => navigations.push(direction),
    feedback: (direction, progress) => feedback.push([direction, progress]),
  })
  gesture.phase("begin")
  gesture.wheel(wheel(-800), allowed)
  expect(feedback.at(-1)).toEqual(["back", 1])
  gesture.wheel(wheel(100), allowed)
  expect(feedback.at(-1)?.[1]).toBe(0)
  gesture.wheel(wheel(136), allowed)
  expect(feedback.at(-1)).toEqual(["forward", 1])
  gesture.wheel(wheel(-100), allowed)
  expect(feedback.at(-1)?.[1]).toBe(0)
  gesture.phase("end")
  expect(navigations).toEqual([])
  gesture.phase("begin")
  gesture.wheel(wheel(-800), allowed)
  gesture.wheel(wheel(236), allowed)
  gesture.phase("end")
  expect(navigations).toEqual(["forward"])
})

test("the starting scroll surface keeps ownership through the entire gesture", () => {
  const { gesture, navigations } = fixture()
  gesture.phase("begin")
  expect(gesture.wheel(wheel(-50), () => true)).toBe(false)
  expect(gesture.wheel(wheel(-200), allowed)).toBe(false)
  gesture.phase("end")
  expect(navigations).toEqual([])
  gesture.phase("begin")
  gesture.wheel(wheel(2, 50), allowed)
  gesture.wheel(wheel(-200), allowed)
  gesture.phase("end")
  expect(navigations).toEqual([])
})

test("horizontal navigation owns vertical drift from the neutral zone through release", () => {
  const { gesture, navigations } = fixture()
  gesture.phase("begin")
  expect(gesture.wheel(wheel(-12, 2), allowed)).toBe(true)
  expect(gesture.wheel(wheel(0, 90), allowed)).toBe(true)
  expect(gesture.wheel(wheel(-120, 20), allowed)).toBe(true)
  expect(gesture.wheel(wheel(118, -70), allowed)).toBe(true)
  gesture.phase("end")
  expect(navigations).toEqual([])
})

test("modifiers, line wheels and an already handled scroll cancel navigation", () => {
  for (const extra of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { deltaMode: 1 },
    { defaultPrevented: true },
  ]) {
    const { gesture, navigations } = fixture()
    gesture.phase("begin")
    gesture.wheel(wheel(-130), allowed)
    gesture.wheel(wheel(-130, 0, extra), allowed)
    gesture.phase("end")
    expect(navigations).toEqual([])
  }
})

test("history availability and modal state are rechecked at release", () => {
  for (const change of ["disable", "unavailable"] as const) {
    const state = fixture()
    state.gesture.phase("begin")
    state.gesture.wheel(wheel(-130), allowed)
    state[change]()
    state.gesture.phase("end")
    expect(state.navigations).toEqual([])
  }
  const state = fixture()
  state.unavailable()
  expect(state.gesture.wheel(wheel(-130), allowed)).toBe(false)
  state.gesture.idle()
  expect(state.navigations).toEqual([])
})

test("closing a modal or releasing a modifier does not reclaim the same finger gesture", () => {
  const state = fixture()
  state.gesture.phase("begin")
  state.disable()
  state.gesture.wheel(wheel(-130), allowed)
  state.enable()
  state.gesture.wheel(wheel(-130), allowed)
  state.gesture.idle()
  state.gesture.phase("end")
  expect(state.navigations).toEqual([])

  state.gesture.phase("begin")
  state.gesture.wheel(wheel(-130), allowed)
  state.gesture.wheel(wheel(-10, 0, { ctrlKey: true }), allowed)
  state.gesture.wheel(wheel(-130), allowed)
  state.gesture.idle()
  state.gesture.phase("end")
  expect(state.navigations).toEqual([])

  state.gesture.phase("begin")
  state.gesture.wheel(wheel(-130), allowed)
  state.gesture.phase("end")
  expect(state.navigations).toEqual(["back"])
})

test("idle fallback, a late native begin and focus reset preserve navigation semantics", () => {
  const { gesture, navigations } = fixture()
  gesture.wheel(wheel(-130), allowed)
  gesture.phase("begin")
  gesture.phase("end")
  expect(gesture.wheel(wheel(-500), allowed)).toBe(true)
  gesture.phase("momentum-end")
  expect(navigations).toEqual(["back"])
  gesture.wheel(wheel(130), allowed)
  gesture.idle()
  gesture.idle()
  expect(navigations).toEqual(["back", "forward"])
  gesture.phase("begin")
  gesture.wheel(wheel(-130), allowed)
  gesture.reset()
  gesture.phase("end")
  expect(navigations).toEqual(["back", "forward"])
})
