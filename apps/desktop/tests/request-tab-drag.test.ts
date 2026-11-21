import { expect, test } from "bun:test"
import { closestTabIndex } from "../app/composables/useRequestTabDrag"

test("a held tab can reach both endpoints, including the first slot's exact center", () => {
  const tabs = [4, 142, 280, 418].map((offsetLeft) => ({ offsetLeft, offsetWidth: 130 }))
  expect(closestTabIndex(tabs, 69)).toBe(0)
  expect(closestTabIndex(tabs, 483)).toBe(3)
  expect(closestTabIndex(tabs, 200)).toBe(1)
  expect(closestTabIndex(tabs, 350)).toBe(2)
})

test("different label widths and scroll offsets do not change the closest layout slot", () => {
  const tabs = [
    { offsetLeft: 4, offsetWidth: 100 },
    { offsetLeft: 112, offsetWidth: 220 },
    { offsetLeft: 340, offsetWidth: 130 },
  ]
  expect(closestTabIndex(tabs, 54)).toBe(0)
  expect(closestTabIndex(tabs, 222)).toBe(1)
  expect(closestTabIndex(tabs, 405)).toBe(2)
})
