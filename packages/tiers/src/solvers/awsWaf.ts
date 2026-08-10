// AWS WAF CAPTCHA solver — switches the official visual grid to its audio
// accessibility challenge, transcribes the audio, submits the answer, and lets
// AWS's own script exchange the resulting voucher for an aws-waf-token cookie.
//
// This deliberately drives the current browser widget instead of reproducing
// AWS's private /problem -> /verify -> /voucher protocol. Keeping the challenge
// script, fingerprint, proxy, and final request in one browser context is both
// less brittle and consistent with Trawl's other CAPTCHA solvers.

import type { Locator, Page } from "patchright"
import { hasAwsWafCaptcha, hasAwsWafInterstitial } from "../utils/detect"
import { transcribeAudio } from "./stt"

const START_SELECTORS = [
  "#captcha-container #amzn-captcha-verify-button",
  ".amzn-captcha-modal #amzn-captcha-verify-button",
  "#amzn-captcha-verify-button",
] as const

const AUDIO_TOGGLE_SELECTORS = [
  "#captcha-container #amzn-btn-audio-internal",
  ".amzn-captcha-modal #amzn-btn-audio-internal",
  "#amzn-btn-audio-internal",
  '#captcha-container #amzn-btn-audio-internal:has(img[title*="Audio"])',
  '.amzn-captcha-modal #amzn-btn-audio-internal:has(img[title*="Audio"])',
  '#amzn-btn-audio-internal:has(img[title*="Audio"])',
  'button[aria-label*="audio" i]',
] as const

const AUDIO_SELECTORS = ["#captcha-container audio", ".amzn-captcha-modal audio", "audio"] as const
const ANSWER_SELECTORS = [
  '#captcha-container input[placeholder*="answer" i]',
  '.amzn-captcha-modal input[placeholder*="answer" i]',
  "#amzn-captcha-audio-input",
  'input[aria-label*="answer" i]',
  'input[placeholder*="answer" i]',
] as const
const SUBMIT_SELECTORS = [
  "#captcha-container #amzn-btn-verify-internal",
  ".amzn-captcha-modal #amzn-btn-verify-internal",
  "#amzn-btn-verify-internal",
] as const
const REFRESH_SELECTORS = [
  "#captcha-container #amzn-btn-refresh-internal",
  ".amzn-captcha-modal #amzn-btn-refresh-internal",
  "#amzn-btn-refresh-internal",
] as const

const WIDGET_SELECTOR = [
  "#amzn-captcha-verify-button",
  "#amzn-btn-audio-internal",
  "#amzn-btn-verify-internal",
  ".amzn-captcha-modal canvas",
  "#captcha-container #root",
].join(", ")

type Transcriber = (audioUrl: string, signal?: AbortSignal) => Promise<string | undefined>

export interface AwsWafCaptchaSolverOptions {
  transcribe?: Transcriber
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function hasAwsWafCaptchaWidget(page: Page, timeoutMs = 2000): Promise<boolean> {
  const widget = page.locator(WIDGET_SELECTOR).first()
  if (timeoutMs <= 0) return widget.isVisible({ timeout: 0 }).catch(() => false)
  return widget
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false)
}

export async function solveAwsWafCaptcha(
  page: Page,
  timeoutMs = 30_000,
  options: AwsWafCaptchaSolverOptions = {},
): Promise<boolean> {
  if (timeoutMs <= 0) return false

  const sleep = options.sleep ?? defaultSleep
  const transcribe = options.transcribe ?? transcribeAudio
  const maxAttempts = options.maxAttempts ?? 3
  const deadline = Date.now() + timeoutMs
  const targetHost = hostnameOf(page.url())
  const initialToken = await getAwsWafToken(page, targetHost)

  const start = await firstVisible(page, START_SELECTORS, 500)
  if (start) {
    await start.click({ timeout: 3000, force: true }).catch(() => {})
    console.log("[aws-waf] opened CAPTCHA puzzle")
    await sleep(300)
  }

  let previousAudio = ""

  for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt++) {
    if (await captchaResolved(page, targetHost, initialToken)) return true

    // Probe once before toggling: the widget remembers the user's accessibility
    // mode, so a returning session may already be showing the audio challenge.
    let task = await findAudioTask(page, 0, sleep)
    if (!task) {
      const toggle = await waitForFirstVisible(
        page,
        AUDIO_TOGGLE_SELECTORS,
        Math.min(4000, deadline - Date.now()),
        sleep,
      )
      if (!toggle) {
        console.log("[aws-waf] audio challenge is unavailable")
        return false
      }
      await toggle.click({ timeout: 3000, force: true }).catch(() => {})
      console.log("[aws-waf] switched to audio challenge")
      task = await findAudioTask(page, Math.min(8000, deadline - Date.now()), sleep)
    }

    if (!task) {
      console.log("[aws-waf] audio challenge did not load")
      return false
    }

    if (task.audioSource === previousAudio) {
      await clickRefresh(page)
      task = await findAudioTask(page, Math.min(5000, deadline - Date.now()), sleep, previousAudio)
      if (!task) continue
    }
    previousAudio = task.audioSource

    const remaining = deadline - Date.now()
    if (remaining <= 1500) return false

    console.log(`[aws-waf] transcribing audio (attempt ${attempt})`)
    const transcript = await transcribe(task.audioSource, AbortSignal.timeout(Math.max(remaining - 1000, 500))).catch(
      () => undefined,
    )
    const answer = extractAwsWafAudioAnswer(transcript)
    if (!answer) {
      console.log("[aws-waf] transcription was empty, refreshing")
      await clickRefresh(page)
      await sleep(300)
      continue
    }

    await task.input.fill(answer, { timeout: 3000 }).catch(() => {})
    const submit = await firstVisible(page, SUBMIT_SELECTORS, 500)
    if (!submit) return false
    await submit.click({ timeout: 3000 }).catch(() => {})
    console.log("[aws-waf] submitted audio answer")

    const verificationDeadline = Math.min(deadline, Date.now() + 6000)
    while (Date.now() < verificationDeadline) {
      if (await captchaResolved(page, targetHost, initialToken)) {
        console.log("[aws-waf] CAPTCHA solved")
        return true
      }

      const nextAudio = await readCurrentAudioSource(page)
      if (nextAudio && nextAudio !== previousAudio) break
      await sleep(250)
    }

    await clickRefresh(page)
  }

  console.log(`[aws-waf] exhausted retries (${maxAttempts})`)
  return false
}

async function firstVisible(page: Page, selectors: readonly string[], timeoutMs: number): Promise<Locator | undefined> {
  const perSelector = Math.max(Math.floor(Math.max(timeoutMs, 0) / selectors.length), 1)
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible({ timeout: perSelector }).catch(() => false)) return locator
  }
  return undefined
}

async function waitForFirstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<Locator | undefined> {
  const deadline = Date.now() + Math.max(timeoutMs, 0)
  do {
    const visible = await firstVisible(page, selectors, 0)
    if (visible) return visible
    if (Date.now() >= deadline) break
    await sleep(150)
  } while (Date.now() < deadline)
  return undefined
}

async function findAudioTask(
  page: Page,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  previousAudio = "",
): Promise<{ input: Locator; audioSource: string } | undefined> {
  const deadline = Date.now() + Math.max(timeoutMs, 0)
  do {
    const input = await firstVisible(page, ANSWER_SELECTORS, 100)
    const audioSource = await readCurrentAudioSource(page)
    if (input && audioSource && audioSource !== previousAudio) return { input, audioSource }
    if (Date.now() >= deadline) break
    await sleep(150)
  } while (Date.now() < deadline)
  return undefined
}

async function readCurrentAudioSource(page: Page): Promise<string> {
  for (const selector of AUDIO_SELECTORS) {
    const audio = page.locator(selector).first()
    if ((await audio.count().catch(() => 0)) === 0) continue
    const source = await audio
      .evaluate(async (element) => {
        const media = element as HTMLAudioElement
        const currentSource = media.currentSrc || media.src
        if (!currentSource?.startsWith("blob:")) return currentSource

        // Blob URLs only exist inside the page. Convert them there so the Node/Bun
        // STT helper can consume the audio after it crosses the browser boundary.
        const response = await fetch(currentSource)
        const blob = await response.blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ""
        const chunkSize = 0x8000
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
        }
        return `data:${blob.type || "audio/aac"};base64,${btoa(binary)}`
      })
      .catch(() => "")
    if (source) return source
  }
  return ""
}

async function clickRefresh(page: Page): Promise<void> {
  const refresh = await firstVisible(page, REFRESH_SELECTORS, 400)
  await refresh?.click({ timeout: 2000, force: true }).catch(() => {})
}

async function captchaResolved(page: Page, targetHost: string, initialToken: string | undefined): Promise<boolean> {
  const html = await page.content().catch(() => "")
  const widgetVisible = await hasAwsWafCaptchaWidget(page, 0)
  if (!widgetVisible && !hasAwsWafInterstitial(html) && !hasAwsWafCaptcha(html)) return true

  const token = await getAwsWafToken(page, targetHost)
  return Boolean(token && token !== initialToken && !widgetVisible)
}

export async function getAwsWafToken(page: Page, targetHost: string): Promise<string | undefined> {
  const cookies: Array<{ name: string; value: string; domain: string }> = await page
    .context()
    .cookies()
    .catch(() => [])
  return cookies.find((cookie) => cookie.name === "aws-waf-token" && domainMatches(targetHost, cookie.domain))?.value
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

function domainMatches(hostname: string, cookieDomain: string): boolean {
  if (!hostname) return false
  const normalized = cookieDomain.replace(/^\./, "")
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

// AWS asks for either of two words, but its audio track also contains the
// spoken instruction and decoy speech. Whisper normally punctuates the
// instruction; Google's zero-key recognizer often does not, so recognize both
// forms and submit only the first answer word after the instruction.
export function extractAwsWafAudioAnswer(transcript: string | undefined): string | undefined {
  if (!transcript) return

  const normalized = transcript.toLowerCase().trim().replace(/\s+/g, " ")
  if (!normalized) return

  const instruction =
    /(?:type|enter|write|repeat)?\s*(?:any\s+)?one\s+of\s+the\s+two\s+following\s+words?\s+spoken\s+by\s+me[\s.,:;!?-]*/i
  const marker = instruction.exec(normalized)
  const spokenByMe = normalized.lastIndexOf("spoken by me")
  const candidates = marker
    ? normalized.slice((marker.index ?? 0) + marker[0].length)
    : spokenByMe >= 0
      ? normalized.slice(spokenByMe + "spoken by me".length)
      : ""

  if (candidates) {
    const words = candidates.match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) ?? []
    const answer = words.find((word) => !["a", "an", "the"].includes(word))
    if (answer) return answer
  }

  const words = normalized.match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) ?? []
  return words.at(-1)
}
