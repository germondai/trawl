import { describe, expect, test } from "bun:test"
import { solveFriendlyCaptchaV1, verifyFriendlyCaptchaSolution } from "../src/solvers/friendlyCaptchaPow"

describe("FriendlyCaptcha v1 PoW solver", () => {
  test("solves a simple puzzle with low difficulty", () => {
    const timestamp = Math.floor(Date.now() / 1000)
    const accountId = 12345
    const appId = 67890
    const version = 1
    const expiry = 10
    const nSolutions = 1
    const difficulty = 100

    const puzzle = new Uint8Array(32)
    const view = new DataView(puzzle.buffer)
    view.setUint32(0, timestamp, false)
    view.setUint32(4, accountId, false)
    view.setUint32(8, appId, false)
    puzzle[12] = version
    puzzle[13] = expiry
    puzzle[14] = nSolutions
    puzzle[15] = difficulty
    for (let i = 24; i < 32; i++) puzzle[i] = Math.floor(Math.random() * 256)

    const puzzleB64 = btoa(String.fromCharCode(...puzzle))
    const signature = "test-signature"
    const puzzleInput = `${signature}.${puzzleB64}`

    const solution = solveFriendlyCaptchaV1(puzzleInput)
    expect(solution).toBeDefined()
    expect(solution?.response).toContain(signature)
    expect(solution?.response.split(".").length).toBe(4)
    expect(solution?.elapsedMs).toBeGreaterThan(0)
  })

  test("verifies a correct solution", () => {
    const puzzle = new Uint8Array(32)
    const view = new DataView(puzzle.buffer)
    view.setUint32(0, Math.floor(Date.now() / 1000), false)
    view.setUint32(4, 1, false)
    view.setUint32(8, 1, false)
    puzzle[12] = 1
    puzzle[13] = 10
    puzzle[14] = 1
    puzzle[15] = 80

    const puzzleB64 = btoa(String.fromCharCode(...puzzle))
    const signature = "sig123"
    const puzzleInput = `${signature}.${puzzleB64}`

    const solution = solveFriendlyCaptchaV1(puzzleInput, 2 ** 24)
    expect(solution).toBeDefined()
    if (solution) {
      expect(verifyFriendlyCaptchaSolution(puzzleInput, solution.response)).toBe(true)
    }
  })

  test("rejects invalid puzzle format", () => {
    expect(solveFriendlyCaptchaV1("invalid")).toBeUndefined()
    expect(solveFriendlyCaptchaV1("sig.!!!invalid-base64!!!")).toBeUndefined()
    expect(solveFriendlyCaptchaV1("")).toBeUndefined()
  })

  test("rejects puzzle that is too short", () => {
    const shortPuzzle = btoa(String.fromCharCode(...new Uint8Array(16)))
    expect(solveFriendlyCaptchaV1(`sig.${shortPuzzle}`)).toBeUndefined()
  })

  test("solves puzzle with multiple solutions", () => {
    const puzzle = new Uint8Array(32)
    const view = new DataView(puzzle.buffer)
    view.setUint32(0, Math.floor(Date.now() / 1000), false)
    view.setUint32(4, 1, false)
    view.setUint32(8, 1, false)
    puzzle[12] = 1
    puzzle[13] = 10
    puzzle[14] = 3
    puzzle[15] = 60

    const puzzleB64 = btoa(String.fromCharCode(...puzzle))
    const puzzleInput = `multisol.${puzzleB64}`

    const solution = solveFriendlyCaptchaV1(puzzleInput, 2 ** 24)
    expect(solution).toBeDefined()
    if (solution) {
      const parts = solution.response.split(".")
      const solutionsB64 = parts[2]
      const solutions = Uint8Array.from(atob(solutionsB64), (c) => c.charCodeAt(0))
      expect(solutions.length).toBe(3 * 8)
      expect(verifyFriendlyCaptchaSolution(puzzleInput, solution.response)).toBe(true)
    }
  })

  test("threshold calculation matches expected values", () => {
    const testCases = [
      { difficulty: 141, expectedApprox: 21245 },
      { difficulty: 163, expectedApprox: 3158 },
    ]

    for (const { difficulty, expectedApprox } of testCases) {
      const threshold = Math.floor(2 ** ((255.999 - difficulty) / 8))
      expect(Math.abs(threshold - expectedApprox)).toBeLessThan(100)
    }
  })
})
