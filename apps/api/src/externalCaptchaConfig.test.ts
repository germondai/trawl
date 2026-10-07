import { expect, test } from "bun:test"
import { parseExternalCaptchaConfig } from "./config"

test("external CAPTCHA solving requires explicit opt-in and a key", () => {
  expect(parseExternalCaptchaConfig({})).toBeUndefined()
  expect(parseExternalCaptchaConfig({ TWOCAPTCHA_API_KEY: "owned-key" })).toBeUndefined()
  expect(() => parseExternalCaptchaConfig({ CAPTCHA_SOLVER: "2captcha" })).toThrow("TWOCAPTCHA_API_KEY is required")
  expect(parseExternalCaptchaConfig({ CAPTCHA_SOLVER: "2captcha", TWOCAPTCHA_API_KEY: "owned-key" })).toEqual({
    apiKey: "owned-key",
    maxTasks: 1,
    timeoutMs: 120000,
    localTimeoutMs: 10000,
  })
})

test("invalid paid task limits fail startup without exposing configuration values", () => {
  for (const name of ["CAPTCHA_SOLVER_MAX_TASKS", "CAPTCHA_SOLVER_TIMEOUT_MS", "CAPTCHA_SOLVER_LOCAL_TIMEOUT_MS"]) {
    for (const value of ["0", "-1", "1.5", "Infinity", "owned-secret", "999999"]) {
      expect(() =>
        parseExternalCaptchaConfig({ CAPTCHA_SOLVER: "2captcha", TWOCAPTCHA_API_KEY: "owned-key", [name]: value }),
      ).toThrow(`${name} must be an integer`)
    }
  }
  expect(() => parseExternalCaptchaConfig({ CAPTCHA_SOLVER: "unknown" })).toThrow(
    "CAPTCHA_SOLVER must be none or 2captcha",
  )
})

test("profile parsing fails startup with a redacted error and remains disabled without opt-in", () => {
  const env = {
    CAPTCHA_SOLVER: "2captcha",
    TWOCAPTCHA_API_KEY: "owned-key",
    CAPTCHA_SOLVER_PROFILES: "owned-secret-invalid-json",
  }
  expect(() => parseExternalCaptchaConfig(env)).toThrow("CAPTCHA_SOLVER_PROFILES")
  try {
    parseExternalCaptchaConfig(env)
  } catch (error) {
    expect(String(error)).not.toContain("owned-secret")
  }
  expect(parseExternalCaptchaConfig({ CAPTCHA_SOLVER_PROFILES: env.CAPTCHA_SOLVER_PROFILES })).toBeUndefined()
  expect(parseExternalCaptchaConfig({ ...env, CAPTCHA_SOLVER_PROFILES: "[]" })?.profiles).toEqual([])
})
