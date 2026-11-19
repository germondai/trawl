import { expect, test } from "bun:test"
import type { BrowserObservationSnapshot } from "@trawl/client"
import { browserSnapshotKey } from "../app/utils/browser-snapshot"
import { rebaseSettingsDraft } from "../app/utils/settings"

test("browser polling ignores sampling time while keeping meaningful page changes", () => {
  const snapshot: BrowserObservationSnapshot = {
    pages: [
      {
        id: "owned-page",
        browserId: 1,
        display: "headless",
        state: "session-idle",
        origin: "https://owned.fixture",
        observedAt: "2026-11-16T00:00:00Z",
      },
    ],
    truncated: false,
    limits: { width: 1280, height: 720, maxBytes: 100000, intervalMs: 1000, timeoutMs: 1000 },
    headedDebug: { supported: true, configured: false, display: "host-window" },
  }
  const next = structuredClone(snapshot)
  if (next.pages[0]) next.pages[0].observedAt = "2026-11-16T00:00:02Z"
  expect(browserSnapshotKey(snapshot)).toBe(browserSnapshotKey(next))
  if (next.pages[0]) next.pages[0].origin = "https://changed.fixture"
  expect(browserSnapshotKey(snapshot)).not.toBe(browserSnapshotKey(next))
})
test("settings refresh adopts new defaults without discarding edits or inherited-value resets", () => {
  const before = { PORT: "8195", HOST: "127.0.0.1" }
  const after = { ...before, HISTORY_CAPTURE_MODE: "html" }
  expect(rebaseSettingsDraft(before, before, after)).toEqual(after)
  expect(rebaseSettingsDraft({ PORT: "8196" }, before, after)).toEqual({ PORT: "8196", HISTORY_CAPTURE_MODE: "html" })
})
