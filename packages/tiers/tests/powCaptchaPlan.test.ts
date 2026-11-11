import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { planPowCaptcha } from "../src/utils/powCaptchaPlan"

const challenge = {
  algorithm: "SHA-256",
  salt: "fixture",
  signature: "server-signature",
  challenge: createHash("sha256").update("fixture0").digest("hex"),
}
const widget = `<altcha-widget challengejson='${JSON.stringify(challenge)}'></altcha-widget>`
const wall = (content = widget, action = "/verify") => `<html><head><title>Captcha</title></head><body>
  <form id="altcha-form" method="post" action="${action}"><input type="hidden" name="csrf" value="csrf&amp;token">${content}</form></body></html>`

test("parses reordered attributes and carries hidden fields with the proof", async () => {
  const plan = planPowCaptcha(wall(), "https://example.com/challenge")
  expect(plan).toBeDefined()
  const submission = await plan?.submit(1000)
  expect(submission?.url).toBe("https://example.com/verify")
  expect(new URLSearchParams(submission?.body).get("csrf")).toBe("csrf&token")
  expect(JSON.parse(atob(new URLSearchParams(submission?.body).get("altcha") ?? ""))).toMatchObject(challenge)
})

test("fetches URL-backed ALTCHA through the supplied request path", async () => {
  const urls: string[] = []
  const plan = planPowCaptcha(
    wall('<altcha-widget challengeurl="/challenge.json"></altcha-widget>'),
    "https://example.com/",
    403,
    async (url) => {
      urls.push(url)
      return challenge
    },
  )
  expect(await plan?.submit(1000)).toBeDefined()
  expect(urls).toEqual(["https://example.com/challenge.json"])
})

test("keeps application forms, callbacks, inert markup and ambiguous forms on the browser path", () => {
  const examples = [
    wall().replace("Captcha", "Checkout"),
    wall().replace("<altcha-widget", '<altcha-widget onverified="submitOrder()"'),
    wall().replace("<altcha-widget", '<altcha-widget data-callback="submitOrder"'),
    wall().replace('id="altcha-form"', 'id="altcha-form" onsubmit="return false"'),
    wall().replace(widget, `${widget}<button onclick="submitOrder()">Continue</button>`),
    wall().replace('id="altcha-form"', 'id="checkout-form"'),
    wall('<div class="frc-captcha" data-sitekey="fixture"><input type="hidden" name="frc-captcha-response"></div>'),
    wall(
      '<script src="https://cdn.jsdelivr.net/npm/@friendlycaptcha/sdk/site.min.js"></script><div class="frc-captcha" data-sitekey="fixture"><input type="hidden" name="frc-captcha-solution"></div>',
    ),
    wall().replace(widget, `<template>${widget}</template>`),
    wall().replace(widget, `<!-- ${widget} -->`),
    wall().replace(widget, `<pre>${widget}</pre>`),
    wall().replace(widget, `${widget}${widget}`),
    wall().replace(widget, `<input name="email">${widget}`),
    wall().replace(widget, `<textarea name="message"></textarea>${widget}`),
    wall().replace(widget, `${widget}<button name="purchase" value="yes">Pay</button>`),
    wall().replace("</body>", '<form action="/other"></form></body>'),
    wall().replace('method="post"', 'method="get"'),
    wall().replace("</head>", '<base href="https://other.example"></head>'),
    wall(widget, "https://other.example/verify"),
    wall(widget, "https://user:secret@example.com/verify"),
  ]
  for (const html of examples) expect(planPowCaptcha(html, "https://example.com/", 403)).toBeUndefined()
})
