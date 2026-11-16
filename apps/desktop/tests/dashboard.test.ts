import { expect, test } from "bun:test"
import type { HealthResponse } from "@trawl/client"
import { activityIndex, activityPoints, capacitySegments, executionTier } from "../app/utils/dashboard"

test("activity selection clamps pointer positions and handles sparse timelines", () => {
  expect(activityIndex(-20, 100, 200, 5)).toBe(0)
  expect(activityIndex(200, 100, 200, 5)).toBe(2)
  expect(activityIndex(900, 100, 200, 5)).toBe(4)
  expect(activityIndex(200, 100, 0, 0)).toBe(0)
  expect(activityIndex(200, 100, 200, 1)).toBe(0)
  const row = { minute: "2026-11-15T17:00:00Z", requests: 4, failures: 1, averageMs: 200 }
  expect(activityPoints([row], "requests")).toBe("500,20")
  expect(activityPoints([row], "failures")).toBe("500,125")
  expect(activityPoints([{ ...row, requests: 0, failures: 0 }], "requests")).toBe("500,160")
})
test("pool allocation accounts for sleeping and missing capacity without double-counting stalled browsers", () => {
  const pool: HealthResponse["pool"] = {
    total: 5,
    available: 1,
    busy: 2,
    sleeping: 1,
    stalled: 1,
    live: 2,
    restarts: 0,
    avgRestarts: 0,
  }
  const segments = capacitySegments(pool)
  expect(segments.map((segment) => segment.value)).toEqual([1, 2, 1, 1])
  expect(segments.reduce((sum, segment) => sum + segment.percent, 0)).toBe(100)
  expect(capacitySegments({ ...pool, total: 0 }).every((segment) => segment.percent === 0)).toBe(true)
  expect(capacitySegments({ ...pool, total: 1 }).map((segment) => segment.value)).toEqual([1, 0, 0, 0])
})
test("unknown or missing request tiers are shown as unrecorded", () => {
  expect(executionTier(0)).toBe("Direct forwarding")
  expect(executionTier(3)).toBe("Browser")
  expect(executionTier(null)).toBe("Not recorded")
  expect(executionTier(99)).toBe("Not recorded")
})
