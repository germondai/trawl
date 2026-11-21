import { expect, test } from "bun:test"
import { createPullRefresh, pullRefreshThreshold } from "../app/utils/pull-refresh"

test("pull refresh commits only a downward pull from a scrollport that began at the top", () => {
  let refreshed = 0,
    distance = 0
  const gesture = createPullRefresh({
    refresh: () => refreshed++,
    feedback: (value) => {
      distance = value
    },
  })
  gesture.start(100, 100, false)
  expect(gesture.move(100, 400)).toBe(false)
  gesture.finish()
  expect(refreshed).toBe(0)
  gesture.start(100, 100, true)
  expect(gesture.move(100, 200)).toBe(true)
  gesture.finish()
  expect(refreshed).toBe(0)
  gesture.start(100, 100, true)
  gesture.move(110, 300)
  expect(distance).toBe(90)
  gesture.finish()
  expect(refreshed).toBe(1)
  expect(distance).toBe(0)
})

test("horizontal movement, upward scrolling, reversal and cancellation never refresh", () => {
  let refreshed = 0
  const gesture = createPullRefresh({ refresh: () => refreshed++, feedback: () => {} })
  for (const [x, y] of [
    [200, 110],
    [100, 50],
  ] as const) {
    gesture.start(100, 100, true)
    expect(gesture.move(x, y)).toBe(false)
    gesture.move(100, 400)
    gesture.finish()
  }
  gesture.start(100, 100, true)
  gesture.move(100, 400)
  gesture.move(100, 110)
  gesture.finish()
  gesture.start(100, 100, true)
  gesture.move(100, 400)
  gesture.finish(true)
  expect(refreshed).toBe(0)
})

test("the longer refresh pull stays cancellable until the full drawing threshold", () => {
  let refreshed = 0
  const gesture = createPullRefresh({ refresh: () => refreshed++, feedback: () => {} })
  gesture.start(100, 100, true)
  gesture.move(100, 260)
  gesture.finish()
  expect(refreshed).toBe(0)
  gesture.start(100, 100, true)
  gesture.move(100, 100 + pullRefreshThreshold / 0.45 + 1)
  gesture.finish()
  expect(refreshed).toBe(1)
})
