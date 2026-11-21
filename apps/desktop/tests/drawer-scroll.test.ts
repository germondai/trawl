import { expect, test } from "bun:test"
import { scrollDrawerContent, scrollDrawerGesture } from "../app/composables/useDrawerGesture"

test("rounded native scroll positions do not hand interior scrolling to the drawer", () => {
  let position = 60
  const scroller = {
    scrollHeight: 500,
    clientHeight: 100,
    get scrollTop() {
      return position
    },
    set scrollTop(value: number) {
      position = Math.round(value)
    },
  }
  for (let i = 0; i < 8; i++) expect(Math.abs(scrollDrawerContent(scroller, -9.6))).toBeLessThan(0.01)
  expect(position).toBe(140)
  expect(scrollDrawerContent(scroller, 180)).toBe(40)
  expect(position).toBe(0)
  expect(scrollDrawerContent(scroller, -440)).toBe(-40)
  expect(position).toBe(400)
})

test("a swipe that scrolls must finish before the next swipe can drag from its edge", () => {
  const scroller = { scrollTop: 25, scrollHeight: 500, clientHeight: 100 }
  const swipe = {}
  expect(scrollDrawerGesture(swipe, [scroller], 70)).toBe(0)
  expect(scroller.scrollTop).toBe(0)
  expect(scrollDrawerGesture(swipe, [scroller], 70)).toBe(0)
  expect(scrollDrawerGesture(swipe, [scroller], -90)).toBe(0)
  expect(scroller.scrollTop).toBe(90)
  expect(scrollDrawerGesture(swipe, [scroller], 120)).toBe(0)
  expect(scrollDrawerGesture({}, [scroller], 70)).toBe(70)
})

test("scroll ownership includes outer scrollports and the bottom edge", () => {
  const inner = { scrollTop: 395, scrollHeight: 500, clientHeight: 100 }
  const outer = { scrollTop: 30, scrollHeight: 500, clientHeight: 100 }
  const swipe = {}
  expect(scrollDrawerGesture(swipe, [inner, outer], -40)).toBe(0)
  expect(inner.scrollTop).toBe(400)
  expect(outer.scrollTop).toBe(65)
  expect(scrollDrawerGesture(swipe, [inner, outer], -500)).toBe(0)
  expect(scrollDrawerGesture(swipe, [inner, outer], -40)).toBe(0)
  expect(scrollDrawerGesture({}, [inner, outer], -40)).toBe(-40)
})
