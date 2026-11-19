import { expect, test } from "bun:test"
import { browserChoiceTags } from "../app/utils/browser-tags"

test("browser tags combine catalog labels with installation and repair state", () => {
  expect(browserChoiceTags({ recommended: true, latest: true, active: true, installed: true })).toEqual([
    "recommended",
    "latest",
    "active",
  ])
  expect(browserChoiceTags({ active: true, installed: true, pending: true })).toEqual(["repair-ready", "active"])
  expect(browserChoiceTags({ active: true, state: "repair-needed" })).toEqual(["active", "repair-needed"])
  expect(browserChoiceTags({ installed: true })).toEqual(["installed"])
  expect(browserChoiceTags({})).toEqual(["not-installed"])
})

test("deprecated and nightly builds retain their state without recommended or latest labels", () => {
  expect(browserChoiceTags({ deprecated: true, recommended: true, latest: true, installed: true })).toEqual([
    "deprecated",
    "installed",
  ])
  expect(browserChoiceTags({ nightly: true, recommended: true, latest: true, installed: true, active: true })).toEqual([
    "nightly",
    "active",
  ])
  expect(browserChoiceTags({ deprecated: true, nightly: true, state: "update-available" })).toEqual([
    "deprecated",
    "nightly",
    "update-available",
  ])
})

test("unsupported and unknown states stay distinct and unexpected states have a visible fallback", () => {
  for (const state of ["update-available", "unsupported", "unknown"]) {
    expect(browserChoiceTags({ supported: false, state, recommended: true, latest: true })).toEqual([state])
  }
  expect(browserChoiceTags({ state: "future-runtime-state" })).toEqual(["unknown"])
})
