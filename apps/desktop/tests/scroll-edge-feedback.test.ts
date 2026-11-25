import { expect, test } from "bun:test"
import { reachedEdge } from "../app/composables/useScrollEdgeFeedback"

test("scroll feedback fires only on arrival at a reachable edge", () => {
  expect(reachedEdge(5, 0, 100)).toBe(true)
  expect(reachedEdge(95, 100, 100)).toBe(true)
  expect(reachedEdge(0, 100, 100)).toBe(true)
  expect(reachedEdge(50, 99.5, 100)).toBe(true)
  expect(reachedEdge(99.5, 100, 100)).toBe(false)
  expect(reachedEdge(0, 0, 100)).toBe(false)
  expect(reachedEdge(0, 4, 100)).toBe(false)
  expect(reachedEdge(5, 50, 100)).toBe(false)
  expect(reachedEdge(0, 2, 2)).toBe(false)
})
