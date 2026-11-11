import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { solveAltcha } from "../src/solvers/altchaPow"
import { fetchAndSolveFriendlyCaptcha, solveFriendlyCaptchaV1 } from "../src/solvers/friendlyCaptchaPow"
import { planPowWall } from "../src/utils/nativePow"
import { planPowCaptcha } from "../src/utils/powCaptchaPlan"
import { friendlyPuzzle } from "./fixtures/friendlyCaptcha"

const challenge = {
  algorithm: "SHA-256",
  challenge: createHash("sha256").update("fixture0").digest("hex"),
  salt: "fixture",
  signature: "signed-by-the-server",
}

test("does not submit an ordinary application's embedded CAPTCHA form", () => {
  const html = `<html><head><title>Contact us</title></head><body><form method="post" action="/contact">
    <input name="email"><altcha-widget challengejson='${JSON.stringify(challenge)}'></altcha-widget>
  </form></body></html>`
  expect(planPowCaptcha(html, "https://example.com/contact")).toBeUndefined()
})

test("preserves ALTCHA's server signature in the submitted proof", async () => {
  const html = `<html><head><title>Captcha</title></head><body><form id="altcha-form" method="post" action="/verify">
    <altcha-widget challengejson='${JSON.stringify(challenge)}'></altcha-widget>
  </form></body></html>`
  const plan = planPowCaptcha(html, "https://example.com/")
  expect(plan).toBeDefined()
  const result = await plan?.submit(1000)
  expect(result).toBeDefined()
  expect(JSON.parse(atob(new URLSearchParams(result?.body).get("altcha") ?? "")).signature).toBe(challenge.signature)
})

test("reads the official Friendly Captcha API envelope", async () => {
  const puzzle = Buffer.alloc(32)
  puzzle[14] = 1
  puzzle[15] = 1
  const encoded = `fixture-signature.${puzzle.toString("base64")}`
  const result = await fetchAndSolveFriendlyCaptcha("fixture", async () => ({ data: { puzzle: encoded } }))
  expect(result?.response).toStartWith(`${encoded}.`)
})

test("all PoW families share one process slot, which is released after timeout", async () => {
  const running = solveAltcha({ ...challenge, challenge: "ff".repeat(32) }, 60)
  const ncbi = planPowWall(
    '<html><body><script>const challengeId = "fixture"; const bits = 0; fetch("/_pow/solve")</script></body></html>',
    "https://example.com/",
  )
  expect(ncbi).toBeDefined()
  expect(await solveFriendlyCaptchaV1(friendlyPuzzle())).toBeUndefined()
  expect(await ncbi?.submit()).toBeUndefined()
  expect(await running).toBeUndefined()
  expect(await ncbi?.submit()).toBeDefined()
})
