import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { planAltcha, planFriendlyCaptcha, planPowCaptcha } from "../src/utils/powCaptchaPlan"

describe("PoW CAPTCHA planners", () => {
  describe("planFriendlyCaptcha", () => {
    test("extracts sitekey and plans solution", async () => {
      const html = `
        <html>
        <form action="/submit" method="POST">
          <div class="frc-captcha" data-sitekey="FCTEST123"></div>
          <input type="hidden" name="frc-captcha-solution" value="">
          <button type="submit">Submit</button>
        </form>
        </html>
      `

      const plan = planFriendlyCaptcha(html, "https://example.com")
      expect(plan).toBeDefined()
      expect(plan?.kind).toBe("friendly-captcha-v1")
    })

    test("extracts embedded puzzle", async () => {
      const html = `
        <form action="/submit" method="POST">
          <div class="frc-captcha" data-puzzle="sig.AAAAAAAAAA"></div>
          <input name="frc-captcha-solution">
        </form>
      `

      const plan = planFriendlyCaptcha(html, "https://example.com")
      expect(plan).toBeDefined()
      expect(plan?.kind).toBe("friendly-captcha-v1")
    })

    test("skips pages with callback (needs JS)", () => {
      const html = `
        <div class="frc-captcha" data-sitekey="TEST" data-callback="onSolved"></div>
        <input name="frc-captcha-solution">
      `

      const plan = planFriendlyCaptcha(html, "https://example.com")
      expect(plan).toBeUndefined()
    })

    test("skips pages without form input", () => {
      const html = `
        <div class="frc-captcha" data-sitekey="TEST"></div>
      `

      const plan = planFriendlyCaptcha(html, "https://example.com")
      expect(plan).toBeUndefined()
    })
  })

  describe("planAltcha", () => {
    test("extracts challenge JSON and plans solution", async () => {
      const salt = "testsalt123"
      const targetCounter = 42
      const challengeHash = createHash("sha256").update(`${salt}${targetCounter}`).digest("hex")

      const challenge = {
        algorithm: "SHA-256",
        salt,
        challenge: challengeHash,
      }
      const html = `
        <form action="/verify" method="POST">
          <altcha-widget challengejson='${JSON.stringify(challenge)}'></altcha-widget>
          <input type="hidden" name="altcha" value="">
        </form>
      `

      const plan = planAltcha(html, "https://example.com")
      expect(plan).toBeDefined()
      expect(plan?.kind).toBe("altcha")

      const result = await plan?.submit(5000)
      expect(result).toBeDefined()
      expect(result?.fieldName).toBe("altcha")
      expect(result?.fieldValue.length).toBeGreaterThan(0)
    })

    test("skips pages with callback", () => {
      const html = `
        <altcha-widget challengejson='{"algorithm":"SHA-256","salt":"x"}' onverified="callback()"></altcha-widget>
      `

      const plan = planAltcha(html, "https://example.com")
      expect(plan).toBeUndefined()
    })

    test("skips invalid challenge JSON", () => {
      const html = `
        <altcha-widget challengejson='invalid-json'></altcha-widget>
        <input name="altcha">
      `

      const plan = planAltcha(html, "https://example.com")
      expect(plan).toBeUndefined()
    })
  })

  describe("planPowCaptcha", () => {
    test("returns undefined for pages without captcha", () => {
      const html = "<html><body>Hello World</body></html>"
      const plan = planPowCaptcha(html, "https://example.com")
      expect(plan).toBeUndefined()
    })

    test("returns undefined for oversized pages", () => {
      const html = "x".repeat(300_000)
      const plan = planPowCaptcha(html, "https://example.com")
      expect(plan).toBeUndefined()
    })

    test("detects friendly captcha", () => {
      const html = `
        <div class="frc-captcha" data-sitekey="TEST"></div>
        <input name="frc-captcha-solution">
      `
      const plan = planPowCaptcha(html, "https://example.com")
      expect(plan?.kind).toBe("friendly-captcha-v1")
    })

    test("detects altcha", () => {
      const html = `
        <altcha-widget challengejson='{"algorithm":"SHA-256","salt":"x","challenge":"y"}'></altcha-widget>
        <input name="altcha">
      `
      const plan = planPowCaptcha(html, "https://example.com")
      expect(plan?.kind).toBe("altcha")
    })
  })
})
