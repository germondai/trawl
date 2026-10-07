import { expect, test } from "bun:test"
import type { Page } from "patchright"
import { solvePageCaptchas } from "../src/solvers"
import { solveCap } from "../src/solvers/cap"
import { detectChallengeType, hasCapChallenge, needsJs } from "../src/utils/detect"

const widgetHtml =
  '<html><head><title>Contact form</title></head><body><cap-widget data-cap-api-endpoint="/api/"></cap-widget></body></html>'

test("recognizes a real CAP component without treating documentation as a widget", () => {
  expect(detectChallengeType(widgetHtml)).toBe("cap")
  expect(needsJs(widgetHtml, {})).toBe(true)
  expect(hasCapChallenge("<cap-widget-demo></cap-widget-demo>")).toBe(false)
  expect(hasCapChallenge("<article>cap-widget uses data-cap-api-endpoint. See https://trycap.dev</article>")).toBe(
    false,
  )
})

test("CAP joins the page solver and only reports a solution after confirmation", async () => {
  const page = {
    content: async () => widgetHtml,
    frames: () => [],
    evaluate: async () => {
      return true
    },
  } as unknown as Page
  expect(await solvePageCaptchas(page, 1000)).toEqual({ attempted: ["cap"], solved: ["cap"] })
})

test("CAP does not report an unavailable or rejected component as solved", async () => {
  const unavailable = { evaluate: async () => false } as unknown as Page
  expect(await solveCap(unavailable, 1000)).toBe(false)
  let calls = 0
  const rejected = { evaluate: async () => (++calls === 1 ? { index: 0 } : false) } as unknown as Page
  expect(await solveCap(rejected, 50)).toBe(false)
})

test("CAP honors cancellation without executing page code", async () => {
  const page = {
    evaluate: async () => {
      throw new Error("must not run")
    },
  } as unknown as Page
  expect(await solveCap(page, 1000, AbortSignal.abort())).toBe(false)
  expect(await solveCap(page, 0)).toBe(false)
})
