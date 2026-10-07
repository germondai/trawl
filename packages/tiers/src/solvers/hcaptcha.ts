import { sleep } from "../utils/deadline"
// hCaptcha solver — checkbox auto-pass + audio STT fallback.
//
// Flow:
//   1. Click the hCaptcha checkbox. With a good IP and a Camoufox Firefox fingerprint,
//      hCaptcha's risk scoring sometimes auto-passes without showing an image challenge.
//   2. If a visual image challenge appears, switch to the audio challenge and solve via
//      speech-to-text (Google's free API or a configured Whisper-compatible endpoint).
//   3. Submit the transcribed digit string and verify.
//
// Site owners can disable the audio option per sitekey — when that happens the solver
// gives up cleanly and returns false. There is no fully free, reliable way to solve
// hCaptcha image grids without an AI/ML model or a paid solving service.

import type { FrameLocator, Page } from "patchright"
import { transcribeAudio } from "./stt"

// hCaptcha widget iframe. newassets.hcaptcha.com is their CDN; don't filter by title
// since the title attribute may not be set yet or may vary across versions.
const WIDGET_FRAME = 'iframe[src*="hcaptcha.com"]:not([src*="frame=challenge"])'
const CHALLENGE_FRAME = 'iframe[src*="hcaptcha.com"][src*="frame=challenge"]'

// Selectors within the hCaptcha challenge UI. Source: Asmodei513/hcaptcha-solver,
// NotHarshhaa/hc_audio_challenger, dev1siN/hc-audio-solver (cross-verified).
const AUDIO_BUTTON = "#audio-button"
const AUDIO_RESPONSE = "textarea#audio-response"
const AUDIO_SUBMIT = "#audio-submit"
const RELOAD_BUTTON = 'button[aria-label="Get a new challenge"]'

const MAX_AUDIO_ATTEMPTS = 3

export async function solveHcaptcha(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  const deadline = Date.now() + timeoutMs
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  try {
    const hasWidget = await page
      .waitForSelector(WIDGET_FRAME, { timeout: Math.max(1, Math.min(8000, deadline - Date.now())), state: "attached" })
      .then(() => true)
      .catch(() => false)
    if (!hasWidget) return false

    // Pick the first hCaptcha iframe (may be multiple on demo pages with difficulty tabs)
    const widget = page.frameLocator(WIDGET_FRAME).first()

    // Step 1: click the checkbox
    await widget
      .locator("#checkbox")
      .click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())), force: true })
    console.log("[hcaptcha] clicked checkbox")

    // Step 2: give hCaptcha's risk scoring time to run
    await sleep(2500, signal)

    // Step 3: check for auto-pass
    if (
      await widget
        .locator('[aria-checked="true"]')
        .isVisible({ timeout: Math.max(1, Math.min(1000, deadline - Date.now())) })
        .catch(() => false)
    ) {
      console.log("[hcaptcha] auto-passed ✓")
      return true
    }

    // Step 4: image challenge appeared — try audio fallback within remaining budget
    const remaining = Math.max(0, deadline - Date.now())
    return await solveHcaptchaAudio(page.frameLocator(CHALLENGE_FRAME).first(), widget, remaining, signal)
  } catch (err) {
    console.log("[hcaptcha] error:", err instanceof Error ? err.message : err)
    return false
  }
}

async function solveHcaptchaAudio(
  widget: FrameLocator,
  checkbox: FrameLocator,
  remainingMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (remainingMs < 5000) {
    console.log("[hcaptcha] not enough time for audio attempt")
    return false
  }

  const deadline = Date.now() + remainingMs
  // Click the audio toggle. Some sitekeys disable audio entirely — fail cleanly.
  const hasAudioButton = await widget
    .locator(AUDIO_BUTTON)
    .waitFor({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())), state: "attached" })
    .then(() => true)
    .catch(() => false)
  if (!hasAudioButton) {
    console.log("[hcaptcha] audio challenge not available for this sitekey")
    return false
  }
  await widget
    .locator(AUDIO_BUTTON)
    .click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())), force: true })
    .catch(() => {})
  console.log("[hcaptcha] switching to audio challenge")

  let attempt = 0

  while (Date.now() < deadline && attempt < MAX_AUDIO_ATTEMPTS) {
    attempt++

    // Wait for the audio element to appear. Some hCaptcha versions render it lazily
    // after the button click.
    const hasAudio = await widget
      .locator("audio")
      .waitFor({ timeout: Math.max(1, Math.min(8000, deadline - Date.now())) })
      .then(() => true)
      .catch(() => false)
    if (!hasAudio) {
      console.log(`[hcaptcha] audio element not found (attempt ${attempt})`)
      continue
    }

    // Get the audio URL via the JS property — more reliable than getAttribute("src")
    // because hCaptcha sets src dynamically after the audio challenge loads.
    const audioHref = await widget
      .locator("audio")
      .evaluate((el) => (el as HTMLAudioElement).src || "")
      .catch(() => "")

    if (!audioHref || audioHref.startsWith("blob:")) {
      console.log(`[hcaptcha] audio URL not usable: ${audioHref?.slice(0, 60) ?? "empty"}`)
      await widget
        .locator(RELOAD_BUTTON)
        .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())), force: true })
        .catch(() => {})
      await sleep(2000, signal)
      continue
    }

    console.log(`[hcaptcha] transcribing audio (attempt ${attempt})`)

    const audioSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
    const answer = await transcribeAudio(audioHref, audioSignal)

    if (!answer) {
      console.log(`[hcaptcha] transcription empty, reloading audio`)
      await widget
        .locator(RELOAD_BUTTON)
        .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())), force: true })
        .catch(() => {})
      await sleep(1500, signal)
      continue
    }

    console.log(`[hcaptcha] answer: ${answer}`)

    // Submit
    await widget
      .locator(AUDIO_RESPONSE)
      .fill(answer, { timeout: Math.max(1, Math.min(3000, deadline - Date.now())) })
      .catch(() => {})
    await widget
      .locator(AUDIO_SUBMIT)
      .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())) })
      .catch(() => {})
    await sleep(2000, signal)

    // Verify pass — hCaptcha marks the widget via aria-checked when solved
    if (
      await checkbox
        .locator('[aria-checked="true"]')
        .isVisible({ timeout: Math.max(1, Math.min(2000, deadline - Date.now())) })
        .catch(() => false)
    ) {
      console.log("[hcaptcha] solved via audio ✓")
      return true
    }

    // Wrong answer — reload the challenge and try again
    console.log(`[hcaptcha] wrong answer, reloading challenge`)
    await widget
      .locator(RELOAD_BUTTON)
      .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())), force: true })
      .catch(() => {})
    await sleep(1500, signal)
  }

  console.log(`[hcaptcha] exhausted retries (${attempt}/${MAX_AUDIO_ATTEMPTS})`)
  return false
}

export async function hasHcaptchaWidget(page: Page, timeout = 2000): Promise<boolean> {
  return page
    .waitForSelector(WIDGET_FRAME, { timeout, state: "attached" })
    .then(() => true)
    .catch(() => false)
}
