import { expect, test } from "bun:test"
import { resourcePresets } from "@trawl/config/catalog"
import { applyResourceProfile, resourceOverrides, resourceProfileName } from "../app/utils/resource-profiles"

test("resource profiles preserve unrelated edits and restore inherited overrides exactly", () => {
  const original = { HOST: "0.0.0.0", BROWSER_IDLE_TIMEOUT_MS: "60000", STT_MODEL: "owned" }
  const previous = resourceOverrides(original)
  expect(previous).toEqual({ BROWSER_IDLE_TIMEOUT_MS: "60000" })
  expect(resourceProfileName(original, {})).toBe("Custom")
  const economy = applyResourceProfile(original, resourcePresets.economy)
  expect(resourceProfileName(economy, {})).toBe("Economy")
  const restored = applyResourceProfile({ ...economy, STT_MODEL: "edited later" }, previous)
  expect(restored).toEqual({ ...original, STT_MODEL: "edited later" })
  expect(resourceOverrides(applyResourceProfile(restored, {}))).toEqual({})
})

test("profile identity honors environment overrides ahead of the draft", () => {
  expect(
    resourceProfileName(resourcePresets.balanced, { BROWSER_COLD_BOOT: "true" }, { BROWSER_COLD_BOOT: "environment" }),
  ).toBe("Custom")
})

test("resource profiles keep manually configured browser pool sizes", () => {
  const original = { BROWSER_POOL_SIZE: "4", STT_MODEL: "owned" }
  expect(Object.keys(resourcePresets)).toEqual(["balanced", "economy"])
  for (const preset of Object.values(resourcePresets)) {
    const next = applyResourceProfile(original, preset)
    expect(next.BROWSER_POOL_SIZE).toBe("4")
    expect(next.STT_MODEL).toBe("owned")
    expect(applyResourceProfile(next, resourceOverrides(original))).toEqual(original)
  }
})
