import { expect, test } from "bun:test"
import { captchaTask, detectExternalCaptchas, validCaptchaTask } from "../src/solvers/captchaCatalog"
import examples from "./captchaApiExamples.json"

for (const example of examples) {
  test(`API reference request: ${example.doc} / ${example.task.type}`, () => {
    expect(captchaTask(example.task.type)?.doc).toBe(
      example.doc === "recaptcha-grid" || example.doc === "funcaptcha-grid" ? "grid" : example.doc,
    )
    expect(validCaptchaTask(example.task)).toBe(true)
  })
}

test("provider markers are detected without treating every image as a CAPTCHA", () => {
  expect(
    detectExternalCaptchas(
      '<script src="https://captcha.qq.com/TCaptcha.js"></script><script src="https://js.hcaptcha.com/1/api.js"></script>',
    ),
  ).toEqual(["tencent"])
  expect(detectExternalCaptchas('<img src="photo.jpg"><audio src="music.mp3"></audio>')).toEqual([])
  expect(
    detectExternalCaptchas('<script src="https://www.google.com/recaptcha/enterprise.js?render=owned-key"></script>'),
  ).toEqual(["recaptcha-v3"])
  expect(detectExternalCaptchas('<script src="https://site/_Incapsula_Resource?abc"></script>')).toEqual(["imperva"])
})

test("incomplete tasks, unknown properties and incorrect proxy modes are rejected", () => {
  expect(validCaptchaTask({ type: "GeeTestTaskProxyless", websiteURL: "https://example.com" })).toBe(false)
  expect(validCaptchaTask({ type: "AltchaTaskProxyless", websiteURL: "https://example.com" })).toBe(false)
  expect(
    validCaptchaTask({
      type: "DataDomeSliderTask",
      websiteURL: "https://example.com",
      captchaUrl: "https://geo.captcha-delivery.com/captcha/",
      userAgent: "owned-UA",
    }),
  ).toBe(false)
  expect(validCaptchaTask({ type: "TextCaptchaTask", comment: "owned-question", clientKey: "secret" })).toBe(false)
  expect(validCaptchaTask({ type: "TextCaptchaTask", comment: "owned-question", proxyType: "http" })).toBe(false)
  expect(
    validCaptchaTask({
      type: "RecaptchaV3TaskProxyless",
      websiteURL: "https://example.com",
      websiteKey: "owned-key",
      minScore: 1,
    }),
  ).toBe(false)
})
