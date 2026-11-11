import { expect, test } from "bun:test"
import { solveFriendlyCaptchaV1 } from "../src/solvers/friendlyCaptchaPow"
import { friendlyPuzzle, verifyFriendlyProof } from "./fixtures/friendlyCaptcha"

test.each([0, 1])(
  "Friendly v1 proof preserves the puzzle at difficulty %s and solves every sub-puzzle",
  async (difficulty) => {
    const puzzle = friendlyPuzzle(difficulty)
    const result = await solveFriendlyCaptchaV1(puzzle)
    expect(result).toBeDefined()
    expect(verifyFriendlyProof(puzzle, result?.response ?? "")).toBe(true)
    expect(verifyFriendlyProof(friendlyPuzzle(2), result?.response ?? "")).toBe(false)
  },
)

test("rejects malformed, oversized and cancelled Friendly puzzles", async () => {
  for (const input of ["", "invalid", "sig.???", `sig.${Buffer.alloc(16).toString("base64")}`, "x".repeat(2049)])
    expect(await solveFriendlyCaptchaV1(input)).toBeUndefined()
  expect(await solveFriendlyCaptchaV1(friendlyPuzzle(), 1000, AbortSignal.abort())).toBeUndefined()
  expect(await solveFriendlyCaptchaV1(friendlyPuzzle(), 0)).toBeUndefined()
})

test("kills an infeasible Friendly solve without a second synchronous fallback", async () => {
  const start = Date.now()
  expect(await solveFriendlyCaptchaV1(friendlyPuzzle(255, 255), 30)).toBeUndefined()
  expect(Date.now() - start).toBeLessThan(1000)
  expect(await solveFriendlyCaptchaV1(friendlyPuzzle())).toBeDefined()
})
