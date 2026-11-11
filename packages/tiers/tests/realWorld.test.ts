import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { solveAltcha, verifyAltchaSolution } from "../src/solvers/altchaPow"
import { fetchAndSolveFriendlyCaptcha } from "../src/solvers/friendlyCaptchaPow"

describe("Real-world PoW solver tests", () => {
  describe("Friendly Captcha v1", () => {
    test("fetches and solves live puzzle from FC demo", async () => {
      const SITEKEY = "FCMGEMUD2M567T8G"

      console.log(`[FC] Fetching puzzle for sitekey: ${SITEKEY}`)
      const solution = await fetchAndSolveFriendlyCaptcha(SITEKEY)

      if (!solution) {
        console.log("[FC] Could not fetch puzzle (network or API issue)")
        return
      }

      console.log(`[FC] Solved in ${solution.elapsedMs}ms`)
      console.log(`[FC] Response: ${solution.response.slice(0, 80)}...`)

      expect(solution.response.length).toBeGreaterThan(50)
      expect(solution.response.split(".").length).toBe(4)
    }, 60000)
  })

  describe("ALTCHA", () => {
    test("solves PBKDF2/SHA-256 challenge from Altcha Playground", async () => {
      const challenge = {
        algorithm: "PBKDF2-SHA-256" as const,
        salt: "4db2e1ee9f2c4b1a8c3d5e6f7a8b9c0d",
        keyPrefix: "00",
        cost: 5000,
      }

      console.log(`[ALTCHA] Solving ${challenge.algorithm} challenge...`)
      console.log(`[ALTCHA] Salt: ${challenge.salt}`)
      console.log(`[ALTCHA] KeyPrefix: ${challenge.keyPrefix}`)
      console.log(`[ALTCHA] Cost: ${challenge.cost}`)

      const start = Date.now()
      const solution = await solveAltcha(challenge, 50000)
      const elapsed = Date.now() - start

      expect(solution).toBeDefined()
      if (solution) {
        console.log(`[ALTCHA] Solved in ${elapsed}ms`)
        console.log(`[ALTCHA] Counter: ${solution.solution.counter}`)
        console.log(`[ALTCHA] DerivedKey: ${solution.solution.derivedKey.slice(0, 32)}...`)

        expect(solution.solution.derivedKey.startsWith(challenge.keyPrefix)).toBe(true)
        expect(await verifyAltchaSolution(challenge, solution.solution.counter)).toBe(true)
      }
    }, 120000)

    test("solves SHA-256 legacy challenge", async () => {
      const salt = "test-salt-12345"
      const targetCounter = 500
      const challengeHash = createHash("sha256").update(`${salt}${targetCounter}`).digest("hex")

      const challenge = {
        algorithm: "SHA-256" as const,
        salt,
        challenge: challengeHash,
      }

      console.log(`[ALTCHA-SHA] Solving SHA-256 challenge...`)
      const solution = await solveAltcha(challenge)

      expect(solution).toBeDefined()
      if (solution) {
        console.log(`[ALTCHA-SHA] Counter: ${solution.solution.counter}`)
        expect(solution.solution.counter).toBe(targetCounter)
      }
    })

    test("solves Scrypt challenge", async () => {
      const challenge = {
        algorithm: "SCRYPT" as const,
        salt: "1234567890abcdef1234567890abcdef",
        keyPrefix: "0",
        cost: 1024,
        memoryCost: 1,
        parallelism: 1,
      }

      console.log(`[ALTCHA-SCRYPT] Solving Scrypt challenge...`)
      const start = Date.now()
      const solution = await solveAltcha(challenge, 500)

      expect(solution).toBeDefined()
      if (solution) {
        console.log(`[ALTCHA-SCRYPT] Solved in ${Date.now() - start}ms`)
        console.log(`[ALTCHA-SCRYPT] Counter: ${solution.solution.counter}`)
        expect(solution.solution.derivedKey.startsWith(challenge.keyPrefix)).toBe(true)
      }
    }, 30000)

    test("solves Argon2id challenge", async () => {
      const challenge = {
        algorithm: "ARGON2ID" as const,
        salt: "1234567890abcdef1234567890abcdef",
        keyPrefix: "0",
        cost: 2,
        memoryCost: 1024,
        parallelism: 1,
      }

      console.log(`[ALTCHA-ARGON2] Solving Argon2id challenge...`)
      const start = Date.now()
      const solution = await solveAltcha(challenge, 100)

      expect(solution).toBeDefined()
      if (solution) {
        console.log(`[ALTCHA-ARGON2] Solved in ${Date.now() - start}ms`)
        console.log(`[ALTCHA-ARGON2] Counter: ${solution.solution.counter}`)
        expect(solution.solution.derivedKey.startsWith(challenge.keyPrefix)).toBe(true)
        expect(await verifyAltchaSolution(challenge, solution.solution.counter)).toBe(true)
      }
    }, 60000)
  })
})
