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
const WIDGET_FRAME = 'iframe[src*="hcaptcha.com"]'

// Selectors within the hCaptcha challenge UI. Source: Asmodei513/hcaptcha-solver,
// NotHarshhaa/hc_audio_challenger, dev1siN/hc-audio-solver (cross-verified).
const AUDIO_BUTTON = "#audio-button"
const AUDIO_RESPONSE = "textarea#audio-response"
const AUDIO_SUBMIT = "#audio-submit"
const RELOAD_BUTTON = 'button[aria-label="Get a new challenge"]'

const MAX_AUDIO_ATTEMPTS = 3

export async function solveHcaptcha(page: Page, timeoutMs = 30_000): Promise<boolean> {
  try {
    const hasWidget = await page
      .waitForSelector(WIDGET_FRAME, { timeout: 8000, state: "attached" })
      .then(() => true)
      .catch(() => false)
    if (!hasWidget) return false

    // Pick the first hCaptcha iframe (may be multiple on demo pages with difficulty tabs)
    const widget = page.frameLocator(WIDGET_FRAME).first()

    // Step 1: click the checkbox
    await widget.locator("#checkbox").click({ timeout: 5000, force: true })
    console.log("[hcaptcha] clicked checkbox")

    // Step 2: give hCaptcha's risk scoring time to run
    await new Promise((r) => setTimeout(r, 2500))

    // Step 3: check for auto-pass
    if (
      await widget
        .locator('[aria-checked="true"]')
        .isVisible({ timeout: 1000 })
        .catch(() => false)
    ) {
      console.log("[hcaptcha] auto-passed ✓")
      return true
    }

    // Step 4: image challenge appeared — try audio fallback within remaining budget
    const remaining = Math.max(timeoutMs - 3000, 5000)
    return await solveHcaptchaAudio(widget, remaining)
  } catch (err) {
    console.log("[hcaptcha] error:", err instanceof Error ? err.message : err)
    return false
  }
}

async function solveHcaptchaAudio(widget: FrameLocator, remainingMs: number): Promise<boolean> {
  if (remainingMs < 5000) {
    console.log("[hcaptcha] not enough time for audio attempt")
    return false
  }

  // Click the audio toggle. Some sitekeys disable audio entirely — fail cleanly.
  const hasAudioButton = await widget
    .locator(AUDIO_BUTTON)
    .waitFor({ timeout: 3000, state: "attached" })
    .then(() => true)
    .catch(() => false)
  if (!hasAudioButton) {
    console.log("[hcaptcha] audio challenge not available for this sitekey")
    return false
  }
  await widget
    .locator(AUDIO_BUTTON)
    .click({ timeout: 5000, force: true })
    .catch(() => {})
  console.log("[hcaptcha] switching to audio challenge")

  const deadline = Date.now() + remainingMs - 1000
  let attempt = 0

  while (Date.now() < deadline && attempt < MAX_AUDIO_ATTEMPTS) {
    attempt++

    // Wait for the audio element to appear. Some hCaptcha versions render it lazily
    // after the button click.
    const hasAudio = await widget
      .locator("audio")
      .waitFor({ timeout: 8000 })
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
        .click({ timeout: 3000, force: true })
        .catch(() => {})
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }

    console.log(`[hcaptcha] transcribing audio (attempt ${attempt})`)

    const signal = AbortSignal.timeout(Math.max(deadline - Date.now() - 3000, 5000))
    const answer = await transcribeAudio(audioHref, signal)

    if (!answer) {
      console.log(`[hcaptcha] transcription empty, reloading audio`)
      await widget
        .locator(RELOAD_BUTTON)
        .click({ timeout: 3000, force: true })
        .catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }

    console.log(`[hcaptcha] answer: ${answer}`)

    // Submit
    await widget
      .locator(AUDIO_RESPONSE)
      .fill(answer, { timeout: 3000 })
      .catch(() => {})
    await widget
      .locator(AUDIO_SUBMIT)
      .click({ timeout: 3000 })
      .catch(() => {})
    await new Promise((r) => setTimeout(r, 2000))

    // Verify pass — hCaptcha marks the widget via aria-checked when solved
    if (
      await widget
        .locator('[aria-checked="true"]')
        .isVisible({ timeout: 2000 })
        .catch(() => false)
    ) {
      console.log("[hcaptcha] solved via audio ✓")
      return true
    }

    // Wrong answer — reload the challenge and try again
    console.log(`[hcaptcha] wrong answer, reloading challenge`)
    await widget
      .locator(RELOAD_BUTTON)
      .click({ timeout: 3000, force: true })
      .catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
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
