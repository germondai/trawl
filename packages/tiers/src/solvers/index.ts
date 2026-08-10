// In-page captcha solver orchestrator.
// All solving is done locally — no external APIs, no billing.
//
// Handles:
//   Cloudflare Turnstile  — iframe checkbox click (embedded widget mode)
//   AWS WAF CAPTCHA       — official audio accessibility challenge via STT
//   reCAPTCHA v2          — checkbox auto-pass + audio challenge via Google's free STT
//   hCaptcha              — checkbox click (auto-pass path only; image grids need AI)
//   GeeTest slide         — human-like mouse drag with canvas gap detection
//
// Called after the page is loaded (post-interstitial).
// Full-page CF and AWS WAF challenges are handled by their dedicated waiters.

import type { Page } from "patchright"
import { hasAwsWafCaptcha } from "../utils/detect"
import { hasAwsWafCaptchaWidget, solveAwsWafCaptcha } from "./awsWaf"
import { hasGeetestSlide, solveGeetestSlide } from "./geetest"
import { hasHcaptchaWidget, solveHcaptcha } from "./hcaptcha"
import { hasRecaptchaV2, solveRecaptchaV2 } from "./recaptcha"
import { solveTurnstile } from "./turnstile"

export interface SolveResult {
  attempted: string[]
  solved: string[]
}

// Check for an in-page Turnstile widget via frame URLs and DOM polling.
// Avoids page.waitForSelector whose timeout option is silently ignored by camoufox-js —
// it always uses the 30s Playwright default regardless of what we pass. We poll instead.
//
// IMPORTANT: we distinguish in-page widgets from the CF interstitial (just-solved)
// by requiring the page's own URL to NOT be a CF challenge/platform URL.
async function detectTurnstile(page: Page, timeoutMs: number): Promise<boolean> {
  const POLL_INTERVAL = 300
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    // If the current page is itself a CF challenge, skip — we're still in the interstitial,
    // not on the target page with an embedded in-page widget.
    const pageUrl = page.url()
    const pageIsCfChallenge =
      pageUrl.includes("cdn-cgi/challenge-platform") || pageUrl.includes("challenges.cloudflare.com")
    if (!pageIsCfChallenge) {
      // Frame URL scan — only count sub-frames in the current (non-challenge) page
      const viaFrame = page.frames().some((f) => {
        // Skip main frame (already checked above), skip same-origin CF challenge frames
        if (f === page.mainFrame()) return false
        const u = f.url()
        return u.includes("challenges.cloudflare.com") || u.includes("cdn-cgi/challenge-platform")
      })
      if (viaFrame) {
        console.log("[solvers] turnstile detected via frame scan")
        return true
      }

      // DOM check — immediate evaluate on the real page
      const viaDOM = await page
        .evaluate(() => {
          if (
            document.querySelector(
              'iframe[src*="challenges.cloudflare.com"], iframe[src*="cdn-cgi/challenge-platform"], .cf-turnstile, #cf-turnstile',
            )
          )
            return "iframe"
          const input = document.querySelector('input[name="cf-turnstile-response"]')
          if (input instanceof HTMLInputElement && input.value.length > 10) return "token"
          return
        })
        .catch(() => undefined)

      if (viaDOM === "iframe") return true
      if (viaDOM === "token") {
        console.log("[solvers] turnstile already auto-solved (token present)")
        return true
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL))
  }

  return false
}

export async function solvePageCaptchas(page: Page, timeoutMs = 30_000): Promise<SolveResult> {
  const attempted: string[] = []
  const solved: string[] = []

  // Quick HTML scan — skip detection entirely for pages with no widget markers
  const html = await page.content().catch(() => "")
  const mightHaveTurnstile = /cf-turnstile|cloudflare\.com\/turnstile/i.test(html)
  const mightHaveAwsWaf = hasAwsWafCaptcha(html)
  const mightHaveRecaptcha = /g-recaptcha|google\.com\/recaptcha|recaptcha\.net|grecaptcha/i.test(html)
  const mightHaveHcaptcha = /h-captcha|hcaptcha\.com/i.test(html)
  const mightHaveGeetest = /geetest|gt_container|initGeetest/i.test(html)

  if (!mightHaveTurnstile && !mightHaveAwsWaf && !mightHaveRecaptcha && !mightHaveHcaptcha && !mightHaveGeetest) {
    return { attempted: [], solved: [] }
  }

  // Trigger IntersectionObserver-based lazy loading by scrolling, then wait briefly
  // for JS-rendered widget iframes to appear (CF Turnstile api.js: 2-5s in Firefox).
  await page
    .evaluate(() => {
      const h = document.body.scrollHeight
      window.scrollTo(0, Math.min(h, 600))
    })
    .catch(() => {})

  const frameUrls = page
    .frames()
    .map((f) => f.url())
    .filter((u) => u && u !== "about:blank")
  if (frameUrls.length > 0) console.log("[solvers] frames:", frameUrls.map((u) => u.slice(0, 80)).join(" | "))

  // waitForSelector already handles waiting for widgets — no blind sleep needed.
  // 3s: Turnstile/reCAPTCHA iframes typically appear within 2s of page load;
  // GeeTest/hCaptcha detect via HTML markers (instant). If nothing in 3s, skip.
  const DETECT_MS = 3_000

  const [hasTurnstile, hasAwsWaf, hasHcaptcha, hasRecaptcha, hasGeetest] = await Promise.all([
    mightHaveTurnstile ? detectTurnstile(page, DETECT_MS) : Promise.resolve(false),
    mightHaveAwsWaf ? hasAwsWafCaptchaWidget(page, DETECT_MS) : Promise.resolve(false),
    mightHaveHcaptcha ? hasHcaptchaWidget(page, DETECT_MS) : Promise.resolve(false),
    mightHaveRecaptcha ? hasRecaptchaV2(page, DETECT_MS) : Promise.resolve(false),
    mightHaveGeetest ? hasGeetestSlide(page, DETECT_MS) : Promise.resolve(false),
  ])

  const count = [hasTurnstile, hasAwsWaf, hasHcaptcha, hasRecaptcha, hasGeetest].filter(Boolean).length
  if (count === 0) {
    console.log(
      `[solvers] markers found in HTML but no interactive widgets detected (${[
        mightHaveTurnstile && "turnstile",
        mightHaveAwsWaf && "aws-waf",
        mightHaveRecaptcha && "recaptcha",
        mightHaveHcaptcha && "hcaptcha",
        mightHaveGeetest && "geetest",
      ]
        .filter(Boolean)
        .join(",")})`,
    )
    return { attempted: [], solved: [] }
  }

  const perMs = Math.floor(timeoutMs / count)

  if (hasTurnstile) {
    attempted.push("turnstile")
    if (await solveTurnstile(page, perMs).catch(() => false)) solved.push("turnstile")
  }

  if (hasAwsWaf) {
    attempted.push("aws-waf")
    if (await solveAwsWafCaptcha(page, perMs).catch(() => false)) solved.push("aws-waf")
  }

  if (hasRecaptcha) {
    attempted.push("recaptcha-v2")
    if (await solveRecaptchaV2(page, perMs).catch(() => false)) solved.push("recaptcha-v2")
  }

  if (hasHcaptcha) {
    attempted.push("hcaptcha")
    if (await solveHcaptcha(page, perMs).catch(() => false)) solved.push("hcaptcha")
  }

  if (hasGeetest) {
    attempted.push("geetest-slide")
    if (await solveGeetestSlide(page, perMs).catch(() => false)) solved.push("geetest-slide")
  }

  if (attempted.length > 0) {
    console.log(`[solvers] attempted=[${attempted.join(",")}] solved=[${solved.join(",")}]`)
  }

  return { attempted, solved }
}
