import { describe, expect, test } from "bun:test"
import { detectChallengeType, isBlocked, isCloudflarePage, needsJs } from "../src/utils/detect"

describe("Cloudflare challenge detection", () => {
  test("treats cf-mitigated challenge as authoritative regardless of case or page title", () => {
    const html = `<html><title>Welcome</title><body>${"content ".repeat(1000)}</body></html>`
    expect(isCloudflarePage(html, { "CF-Mitigated": "Challenge" })).toBe(true)
  })

  test("detects active orchestration markers on large pages", () => {
    const padding = "content ".repeat(1000)
    expect(isCloudflarePage(`<script>window._cf_chl_opt={}</script>${padding}`, {})).toBe(true)
    expect(isCloudflarePage(`<form id="challenge-form"></form>${padding}`, {})).toBe(true)
    expect(
      isCloudflarePage(`<script src="/cdn-cgi/challenge-platform/orchestrate/chl_page/v1"></script>${padding}`, {}),
    ).toBe(true)
  })

  test("allows passive Cloudflare telemetry on an ordinary large page", () => {
    const html = `<html><title>Real page</title><body>${"content ".repeat(1000)}<script>__CF$cv$params={}</script><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`
    expect(isCloudflarePage(html, {})).toBe(false)
  })

  test.each([
    "<html><title>Article</title><body><p>Some sites ask you to verify you are human.</p></body></html>",
    "<html><title>Checking delivery status</title><body><p>Your parcel is on its way.</p></body></html>",
    "<html><title>Article</title><body><!-- <script>window._cf_chl_opt={}</script> --></body></html>",
    '<html><title>Article</title><body><pre>&lt;div class="cf-turnstile"&gt;&lt;/div&gt;</pre></body></html>',
    '<html><title>Article</title><body><template><div class="cf-turnstile"></div></template></body></html>',
    '<html><title>Article</title><body><script type="application/json">{"example":"https://challenges.cloudflare.com/turnstile/v0/api.js"}</script></body></html>',
    "<html><title>Article</title><body><!-- <title>Just a moment...</title> --></body></html>",
    '<html><title>Article</title><body><pre>&lt;form id="challenge-form"&gt;&lt;/form&gt;</pre></body></html>',
    '<html><title>Article</title><body><template><form id="challenge-form"></form></template></body></html>',
    "<html><title>Article</title><body><!-- <script>__CF$cv$params={}</script> --></body></html>",
    "<html><body><noscript><title>Just a moment...</title></noscript><p>Article</p></body></html>",
    '<html><body><script type="module;example">window._cf_chl_opt={}</script><p>Article</p></body></html>',
    '<html><body><script TYPE="application/json">{"_cf_chl_opt":{}}</script><p>Article</p></body></html>',
  ])("does not escalate ordinary text or inert examples: %s", (html) => {
    expect(detectChallengeType(html, {}, 200)).toBe("none")
    expect(isCloudflarePage(html, {})).toBe(false)
    expect(isBlocked(200, html)).toBe(false)
    expect(needsJs(html, {})).toBe(false)
    expect(detectChallengeType(html, { server: "cloudflare" }, 200)).toBe("none")
  })

  test.each([
    "Just a moment...",
    "Please wait",
    "Checking your browser before accessing example.test",
    "Attention Required! | Cloudflare",
  ])("keeps recognized interstitial titles: %s", (title) => {
    expect(isCloudflarePage(`<html><title>${title}</title><body>Checking...</body></html>`, {})).toBe(true)
  })

  test.each([
    '<div class="cf-turnstile" data-sitekey="test"></div>',
    "<div class='contact cf-turnstile' data-sitekey='test'></div>",
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
    '<iframe src="https://challenges.cloudflare.com/turnstile/v0/test"></iframe>',
    '<iframe src="/cdn-cgi/challenge-platform/h/b/turnstile/test"></iframe>',
    '<div CLASS="contact cf-turnstile" data-sitekey="test"></div>',
    '<script SRC="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
  ])("keeps detection of active Turnstile markup: %s", (html) => {
    expect(detectChallengeType(html, {}, 200)).toBe("cloudflare-turnstile")
  })

  test.each([
    '<div ID="cf-error-details">Access denied</div>',
    '<script SRC="/cdn-cgi/challenge-platform/orchestrate/chl_page/v1"></script>',
  ])("keeps valid case-insensitive HTML attributes: %s", (html) => {
    expect(isCloudflarePage(html, {})).toBe(true)
  })
})
