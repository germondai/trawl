import { sleep } from "../utils/deadline"
// In-page captcha solver orchestrator.
// Built-in solvers run first. An explicitly configured external session may follow.
//
// Handles:
//   Cloudflare Turnstile  — iframe checkbox click (embedded widget mode)
//   reCAPTCHA v2          — checkbox auto-pass + audio challenge via Google's free STT
//   hCaptcha              — checkbox click (auto-pass path only; image grids need AI)
//   GeeTest slide         — human-like mouse drag with canvas gap detection
//   Altcha PoW           — client-side SHA-256 Proof-of-Work computation
//   Friendly Captcha PoW  — client-side Proof-of-Work puzzle solving
//   CAP                   — native component PoW and response token verification
//
// Called after the page is loaded (post-CF-interstitial).
// Interstitial-level CF challenges are handled separately in challengeWait.ts.

import type { Page } from "patchright"
import {
  hasAltcha as hasAltchaMarkup,
  hasCapChallenge,
  hasFriendlyCaptcha as hasFriendlyCaptchaMarkup,
} from "../utils/detect"
import { hasAltchaWidget, solveAltcha } from "./altcha"
import { hasCapWidget, solveCap } from "./cap"
import type { ExternalCaptchaSession } from "./externalCaptcha"
import { hasFriendlyCaptchaWidget, solveFriendlyCaptcha } from "./friendlyCaptcha"
import { hasGeetestSlide, solveGeetestSlide } from "./geetest"
import { hasHcaptchaWidget, solveHcaptcha } from "./hcaptcha"
import { hasRecaptchaV2, solveRecaptchaV2 } from "./recaptcha"
import { solveTurnstile } from "./turnstile"

export { hasAltchaWidget, solveAltcha } from "./altcha"
export { hasFriendlyCaptchaWidget, solveFriendlyCaptcha } from "./friendlyCaptcha"

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
async function detectTurnstile(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
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

    await sleep(POLL_INTERVAL, signal)
  }

  return false
}

export async function solvePageCaptchas(
  page: Page,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  external?: ExternalCaptchaSession,
  proxy?: string,
): Promise<SolveResult> {
  if (timeoutMs <= 0 || signal?.aborted) return { attempted: [], solved: [] }
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const attempted: string[] = []
  const solved: string[] = []

  // Quick HTML scan — skip detection entirely for pages with no widget markers
  const html = await page.content().catch(() => "")
  const externalProfiles = (await external?.discover(page, html).catch(() => [])) ?? []
  const mightHaveTurnstile = /cf-turnstile|cloudflare\.com\/turnstile/i.test(html)
  const mightHaveRecaptcha = /g-recaptcha|google\.com\/recaptcha|recaptcha\.net|grecaptcha/i.test(html)
  const mightHaveHcaptcha = /h-captcha|hcaptcha\.com/i.test(html)
  const mightHaveGeetest = /geetest|gt_container|initGeetest/i.test(html)
  const mightHaveAltcha = hasAltchaMarkup(html)
  const mightHaveCap = hasCapChallenge(html)
  const mightHaveFriendlyCaptcha = hasFriendlyCaptchaMarkup(html)

  if (
    !mightHaveTurnstile &&
    !mightHaveRecaptcha &&
    !mightHaveHcaptcha &&
    !mightHaveGeetest &&
    !mightHaveAltcha &&
    !mightHaveFriendlyCaptcha &&
    !mightHaveCap &&
    !externalProfiles.length
  ) {
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
  // 5s: Turnstile/reCAPTCHA iframes typically appear within 2s of page load;
  // dynamic script-mounted widgets (e.g. Mojeek ALTCHA) can take 2-4s to load module scripts.
  const DETECT_MS = Math.min(5_000, Math.max(0, deadline - Date.now()))

  const recaptchaKind =
    mightHaveRecaptcha && !signal?.aborted && (await external?.canSolve(page, "recaptcha-v2-enterprise", proxy))
      ? "recaptcha-v2-enterprise"
      : "recaptcha-v2"
  const externalRecaptcha =
    mightHaveRecaptcha && !signal?.aborted && (await external?.canSolve(page, recaptchaKind, proxy))
  const [hasTurnstile, hasHcaptcha, hasRecaptchaFrame, hasGeetest, hasAltcha, hasFriendlyCaptcha, hasCap] =
    await Promise.all([
      mightHaveTurnstile ? detectTurnstile(page, DETECT_MS, signal) : Promise.resolve(false),
      mightHaveHcaptcha ? hasHcaptchaWidget(page, DETECT_MS) : Promise.resolve(false),
      mightHaveRecaptcha
        ? externalRecaptcha
          ? page
              .evaluate(() => Boolean(document.querySelector('iframe[src*="recaptcha"][src*="anchor"]')))
              .catch(() => false)
          : hasRecaptchaV2(page, DETECT_MS)
        : Promise.resolve(false),
      mightHaveGeetest ? hasGeetestSlide(page, DETECT_MS) : Promise.resolve(false),
      mightHaveAltcha ? hasAltchaWidget(page, DETECT_MS) : Promise.resolve(false),
      mightHaveFriendlyCaptcha ? hasFriendlyCaptchaWidget(page, DETECT_MS) : Promise.resolve(false),
      mightHaveCap ? hasCapWidget(page, DETECT_MS, signal) : Promise.resolve(false),
    ])

  const hasRecaptcha = hasRecaptchaFrame || Boolean(externalRecaptcha)
  const count = [hasTurnstile, hasHcaptcha, hasRecaptcha, hasGeetest, hasAltcha, hasFriendlyCaptcha, hasCap].filter(
    Boolean,
  ).length
  if (count === 0 && !externalProfiles.length) {
    console.log(
      `[solvers] markers found in HTML but no interactive widgets detected (${[
        mightHaveTurnstile && "turnstile",
        mightHaveRecaptcha && "recaptcha",
        mightHaveHcaptcha && "hcaptcha",
        mightHaveGeetest && "geetest",
        mightHaveAltcha && "altcha",
        mightHaveFriendlyCaptcha && "friendly-captcha",
        mightHaveCap && "cap",
      ]
        .filter(Boolean)
        .join(",")})`,
    )
    return { attempted: [], solved: [] }
  }

  const available = Math.max(0, deadline - Date.now())
  let profileReady = false
  for (const kind of externalProfiles) {
    if (signal?.aborted) break
    if (await external?.canSolve(page, kind, proxy)) profileReady = true
  }
  const perMs = Math.floor(
    (profileReady && external ? external.localBudget(available) : available) / Math.max(1, count),
  )
  const remaining = () => Math.min(perMs, Math.max(0, deadline - Date.now()))

  const attempt = async (kind: string, local: typeof solveTurnstile) => {
    attempted.push(kind)
    const eligible = remaining() > 5000 && !signal?.aborted && (await external?.canSolve(page, kind, proxy))
    const ms = eligible && external ? external.localBudget(remaining()) : remaining()
    if (await local(page, ms, signal).catch(() => false)) {
      solved.push(kind)
    } else if (eligible && external?.supports(kind) && !signal?.aborted && remaining() > 0) {
      attempted.push(`${kind}:2captcha`)
      if (await external.solve(page, kind, remaining(), signal, proxy)) solved.push(`${kind}:2captcha`)
    }
  }

  if (hasTurnstile && !signal?.aborted && remaining() > 0) {
    await attempt("turnstile", solveTurnstile)
  }

  if (hasRecaptcha && !signal?.aborted && remaining() > 0) {
    await attempt(recaptchaKind, hasRecaptchaFrame ? solveRecaptchaV2 : async () => false)
  }

  if (hasHcaptcha && !signal?.aborted && remaining() > 0) {
    attempted.push("hcaptcha")
    if (await solveHcaptcha(page, remaining(), signal).catch(() => false)) solved.push("hcaptcha")
  }

  if (hasGeetest && !signal?.aborted && remaining() > 0) {
    attempted.push("geetest-slide")
    if (await solveGeetestSlide(page, remaining(), signal).catch(() => false)) solved.push("geetest-slide")
  }

  if (hasAltcha && !signal?.aborted && remaining() > 0) {
    attempted.push("altcha")
    if (await solveAltcha(page, remaining(), signal).catch(() => false)) solved.push("altcha")
  }

  if (hasFriendlyCaptcha && !signal?.aborted && remaining() > 0) {
    attempted.push("friendly-captcha")
    if (await solveFriendlyCaptcha(page, remaining(), signal).catch(() => false)) solved.push("friendly-captcha")
  }

  if (hasCap && !signal?.aborted && remaining() > 0) {
    attempted.push("cap")
    if (await solveCap(page, remaining(), signal).catch(() => false)) solved.push("cap")
  }

  for (const kind of externalProfiles) {
    if (signal?.aborted || deadline - Date.now() <= 5000) break
    if (!external || !(await external.canSolve(page, kind, proxy))) continue
    attempted.push(`${external.label(kind)}:2captcha`)
    if (await external.solve(page, kind, deadline - Date.now(), signal, proxy))
      solved.push(`${external.label(kind)}:2captcha`)
  }

  if (attempted.length > 0) {
    console.log(`[solvers] attempted=[${attempted.join(",")}] solved=[${solved.join(",")}]`)
  }

  return { attempted, solved }
}
