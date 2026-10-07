import { expect, test } from "bun:test"
import type { Page } from "patchright"
import { solveHcaptcha } from "../src/solvers/hcaptcha"

function fixture(autoPass: boolean) {
  const frames: string[] = []
  const clicks: string[] = []
  const page = {
    waitForSelector: async () => ({}),
    frameLocator(selector: string) {
      frames.push(selector)
      return {
        first() {
          return this
        },
        locator(control: string) {
          return {
            click: async () => {
              clicks.push(control)
            },
            isVisible: async () => autoPass && control === '[aria-checked="true"]',
            waitFor: async () => {
              throw new Error("This fixture has no audio challenge")
            },
          }
        },
      }
    },
  } as unknown as Page
  return { page, frames, clicks }
}

test("hCaptcha keeps the checkbox auto-pass path", async () => {
  const { page, frames, clicks } = fixture(true)
  expect(await solveHcaptcha(page, 4000)).toBe(true)
  expect(clicks).toEqual(["#checkbox"])
  expect(frames).toHaveLength(1)
})

test("hCaptcha looks for audio in the challenge iframe, not the checkbox iframe", async () => {
  const { page, frames } = fixture(false)
  expect(await solveHcaptcha(page, 10000)).toBe(false)
  expect(frames).toHaveLength(2)
  expect(frames[0]).toContain(':not([src*="frame=challenge"])')
  expect(frames[1]).toBe('iframe[src*="hcaptcha.com"][src*="frame=challenge"]')
})
