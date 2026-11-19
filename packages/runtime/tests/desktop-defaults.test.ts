import { expect, test } from "bun:test"
import { applyDesktopHistoryDefaults, desktopHistoryDefaults } from "../src/desktop-defaults"

test("desktop capture defaults are small and preserve explicit opt-outs and custom limits", () => {
  const sources = Object.fromEntries(Object.keys(desktopHistoryDefaults).map((key) => [key, "default"]))
  expect(applyDesktopHistoryDefaults({ OBSERVABILITY_ENABLED: "false" }, sources)).toEqual({})
  expect(applyDesktopHistoryDefaults({ OBSERVABILITY_ENABLED: "true" }, sources)).toEqual(desktopHistoryDefaults)
  expect(
    applyDesktopHistoryDefaults(
      { OBSERVABILITY_ENABLED: "true" },
      {
        ...sources,
        HISTORY_CAPTURE_REQUESTS: "file",
        HISTORY_CAPTURE_MODE: "environment",
        HISTORY_CAPTURE_STORAGE_BYTES: "flag",
      },
    ),
  ).not.toHaveProperty("HISTORY_CAPTURE_MODE")
  expect(
    applyDesktopHistoryDefaults({ OBSERVABILITY_ENABLED: "true" }, { ...sources, HISTORY_CAPTURE_REQUESTS: "file" }),
  ).not.toHaveProperty("HISTORY_CAPTURE_REQUESTS")
})
