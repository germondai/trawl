import { expect, test } from "bun:test"
import { appTourSteps, tourPlacement } from "../app/utils/app-tour"
import { applyAppLanguage } from "../app/utils/localization"

test("tour fits beside a sidebar target and stays inside a phone viewport", () => {
  const sidebar = { x: 16, y: 100, width: 48, height: 250 }
  expect(tourPlacement(sidebar, { width: 360, height: 320 }, { width: 1440, height: 900 })).toEqual({
    x: 78,
    y: 100,
    width: 360,
  })
  const phone = tourPlacement(
    { x: 0, y: 740, width: 390, height: 80 },
    { width: 360, height: 340 },
    { width: 390, height: 844 },
  )
  expect(phone.x).toBeGreaterThanOrEqual(16)
  expect(phone.x + phone.width).toBeLessThanOrEqual(374)
  expect(phone.y).toBeGreaterThanOrEqual(16)
  expect(phone.y + 340).toBeLessThanOrEqual(828)
})

test("Android-local tour explains its runtime and skips unavailable sessions", () => {
  const android = appTourSteps(true, true)
  expect(android.some((step) => step.page === "sessions")).toBe(false)
  expect(android.find((step) => step.id === "instance")?.detail).toContain("system WebView")
  expect(appTourSteps(false, false).some((step) => step.page === "sessions")).toBe(true)
  expect(new Set(android.map((step) => step.id)).size).toBe(android.length)
})

test("tour explains read-only remote settings and Android's supported controls", () => {
  const detail = (phone: boolean, android: boolean, remote: boolean) =>
    appTourSteps(phone, android, remote).find((step) => step.id === "settings")?.detail
  expect(detail(false, false, true)).toContain("read-only")
  expect(detail(true, true, false)).not.toContain("MCP")
  expect(detail(false, false, false)).toContain("Standard and Economy")
  expect(appTourSteps(true, true).find((step) => step.id === "instance")?.target).toBe("instance")
})

test("tour collision placement respects header and bottom-navigation bounds", () => {
  const viewport = { x: 0, y: 72, width: 390, height: 630 }
  for (const target of [
    { x: 8, y: 12, width: 42, height: 42 },
    { x: 4, y: 776, width: 382, height: 64 },
    { x: 12, y: 400, width: 365, height: 50 },
  ]) {
    const p = tourPlacement(target, { width: 360, height: 340 }, viewport)
    expect(p.x).toBeGreaterThanOrEqual(16)
    expect(p.y).toBeGreaterThanOrEqual(88)
    expect(p.x + p.width).toBeLessThanOrEqual(374)
    expect(p.y + 340).toBeLessThanOrEqual(686)
  }
})

test("tour stays beside bottom-corner controls instead of covering them", () => {
  for (const target of [
    { x: 8, y: 650, width: 48, height: 48 },
    { x: 920, y: 650, width: 48, height: 48 },
  ]) {
    const card = { width: 360, height: 320 }
    const p = tourPlacement(target, card, { width: 1000, height: 720 })
    const overlaps =
      p.x < target.x + target.width &&
      p.x + p.width > target.x &&
      p.y < target.y + target.height &&
      p.y + card.height > target.y
    expect(overlaps).toBe(false)
    expect(p.y + card.height).toBeLessThanOrEqual(704)
  }
})

test("a tall phone card scrolls in the available space without covering its target", () => {
  const target = { x: 12, y: 240, width: 366, height: 48 }
  const p = tourPlacement(target, { width: 360, height: 600 }, { x: 0, y: 72, width: 390, height: 640 })
  expect(p.y).toBeGreaterThanOrEqual(target.y + target.height + 14)
  expect(p.maxHeight).toBeDefined()
  expect(p.y + (p.maxHeight ?? 600)).toBeLessThanOrEqual(696)
})

test("tour cards follow the anchor's preferred side and alignment", () => {
  const viewport = { x: 0, y: 64, width: 1200, height: 760 }
  const card = { width: 360, height: 300 }
  const navigation = { x: 16, y: 180, width: 48, height: 420 }
  expect(tourPlacement(navigation, card, viewport, "right")).toMatchObject({ x: 78, y: 240 })
  const commands = { x: 16, y: 100, width: 48, height: 48 }
  expect(tourPlacement(commands, card, viewport, "right-start")).toMatchObject({ x: 78, y: 100 })
  const toolbar = { x: 970, y: 16, width: 180, height: 40 }
  expect(tourPlacement(toolbar, card, viewport, "bottom-end")).toMatchObject({ x: 790, y: 80 })
})

test("localized tours retain stable navigation identities in every supported language", () => {
  const identities = appTourSteps(false, false).map(({ id, page, target }) => ({ id, page, target }))
  try {
    for (const language of ["en", "cs", "sk", "pl", "de", "fr"] as const) {
      applyAppLanguage(language)
      const tour = appTourSteps(false, false)
      expect(tour.map(({ id, page, target }) => ({ id, page, target }))).toEqual(identities)
      expect(
        tour.every((step) =>
          [step.title, step.description, step.detail].every((text) => text.length > 10 && !text.startsWith("tour.")),
        ),
      ).toBe(true)
      if (language !== "en") expect(tour[0]?.title).not.toBe("Your workspace")
    }
  } finally {
    applyAppLanguage("en")
  }
})

test("tour does not use a narrow gap that cannot fit its fixed controls", () => {
  const p = tourPlacement(
    { x: 12, y: 180, width: 366, height: 60 },
    { width: 360, height: 360, minHeight: 200 },
    { width: 390, height: 400 },
  )
  expect(p.maxHeight === undefined || p.maxHeight >= 200).toBe(true)
})
