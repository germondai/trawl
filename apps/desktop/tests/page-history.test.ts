import { expect, test } from "bun:test"
import { movePage, type PageHistory, visitPage } from "../app/utils/page-history"

test("page history only changes on accepted navigation and drops a forward branch", () => {
  const initial: PageHistory = { entries: ["overview"], index: 0 }
  expect(movePage(initial, -1)).toBe(initial)
  const settings = visitPage(initial, "settings")
  const logs = visitPage(settings, "logs")
  const back = movePage(logs, -1)
  expect(back.entries[back.index]).toBe("settings")
  // A pending/cancelled navigation does not mutate the committed history.
  movePage(back, -1)
  expect(back.index).toBe(1)
  expect(movePage(back, 1)).toEqual(logs)
  const branched = visitPage(back, "browser")
  expect(branched).toEqual({ entries: ["overview", "settings", "browser"], index: 2 })
  expect(movePage(branched, 1)).toBe(branched)
  expect(visitPage(branched, "browser")).toBe(branched)
  expect(initial).toEqual({ entries: ["overview"], index: 0 })
})

test("native shell keeps a local CSP and narrowly grants dragging", async () => {
  const config = await Bun.file(new URL("../src-tauri/tauri.conf.json", import.meta.url)).json()
  const capability = await Bun.file(new URL("../src-tauri/capabilities/default.json", import.meta.url)).json()
  expect(config.app.windows[0].visible).toBe(false)
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-src blob:")
    expect(policy).not.toContain("upgrade-insecure-requests")
  }
  expect(capability.windows).toEqual(["main"])
  expect(capability.remote).toBeUndefined()
  expect(capability.permissions).toEqual(["core:default", "core:window:allow-start-dragging"])
})
