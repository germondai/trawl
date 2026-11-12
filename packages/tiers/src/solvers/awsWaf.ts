// AWS WAF CAPTCHA solver (audio puzzle).
//
// The widget offers an image grid and an accessibility alternative that plays a short
// clip: a voice says "type one of the two following words spoken by me" and names two
// words while another voice reads unrelated prose. The clip travels inside the
// `problem?kind=audio` response (`assets.audio`, base64), and a wrong answer comes back
// with the next puzzle in the `/verify` response.
//
// This drives the real widget, so the SDK builds its own request and state; the solver
// only reads the audio, types the transcribed word and clicks Confirm. It needs a speech
// recogniser that can pick the foreground voice out of the noise (see STT_URL/STT_MODEL).

import type { Frame, Page, Response } from "patchright"
import { sleep } from "../utils/deadline"
import { extractAwsWafAnswer } from "./awsWafAnswer"
import { transcribeAudioBytes } from "./stt"

const START = "#amzn-captcha-verify-button"
const VERIFY = "#amzn-btn-verify-internal"
const AUDIO_TOGGLE = "#amzn-btn-audio-internal"
const REFRESH = "#amzn-btn-refresh-internal"
const ANSWER = "#amzn-captcha-audio-answer"
const LANG_SELECT = "#amzn-captcha-lang-select"
const LANG_APPLY = ".amzn-captcha-lang-apply"
// The puzzle is spoken in the widget's language, and the answer extractor reads the
// English instruction, so the widget is switched to English whatever the browser locale.
const LANG = "en"
// Only AWS's own endpoints carry the puzzle and the verdict. A page can have a `/verify`
// of its own, and its JSON must never be mistaken for AWS accepting an answer.
const AWS_HOST = /(?:^|\.)awswaf\.com$/i

const MAX_SUBMISSIONS = 3
// Puzzles whose transcript has no usable answer are replaced without being submitted,
// so the total number of rounds is bounded separately from the submissions.
const MAX_ROUNDS = 6
const MAX_AUDIO_BASE64 = 2_000_000

interface VerifyBody {
  success?: boolean
  problem?: { assets?: { audio?: unknown } }
}

async function visible(frame: Frame, selector: string): Promise<boolean> {
  return frame
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false)
}

async function widgetFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    for (const selector of [START, VERIFY, ANSWER]) {
      if (await visible(frame, selector)) return frame
    }
  }
}

async function hasAwsWafCaptchaWidget(page: Page, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    if (signal?.aborted) return false
    if (await widgetFrame(page)) return true
    if (Date.now() >= deadline) break
    await sleep(Math.min(200, deadline - Date.now()), signal).catch(() => {})
  } while (Date.now() < deadline)
  return false
}

async function until(check: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
  const end = Date.now() + Math.max(0, ms)
  while (Date.now() < end) {
    if (check()) return true
    if (signal?.aborted) return false
    await sleep(Math.min(100, Math.max(1, end - Date.now())), signal).catch(() => {})
  }
  return check()
}

function isAwsEndpoint(url: string): boolean {
  try {
    return AWS_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

async function useEnglish(frame: Frame, timeout: number): Promise<void> {
  const select = frame.locator(LANG_SELECT)
  if (!(await select.count().catch(() => 0))) return
  if ((await select.inputValue({ timeout }).catch(() => LANG)) === LANG) return
  await select.selectOption(LANG, { timeout })
  await frame.locator(LANG_APPLY).click({ timeout })
}

function decodeAudio(base64: string): Uint8Array | undefined {
  if (!base64 || base64.length > MAX_AUDIO_BASE64) return
  const bytes = Buffer.from(base64, "base64")
  return bytes.length > 0 ? new Uint8Array(bytes) : undefined
}

export async function solveAwsWaf(
  page: Page,
  timeoutMs = 60_000,
  signal?: AbortSignal,
  // Injectable so the widget loop can be exercised without a recogniser.
  transcribe: typeof transcribeAudioBytes = transcribeAudioBytes,
): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  const step = (cap: number) => Math.max(1, Math.min(cap, remaining()))

  // The listener below mutates this while the loop awaits, so it lives on an object:
  // plain `let` bindings get narrowed by control flow and the reads would never type-check.
  const state: { audio?: string; verify?: VerifyBody } = {}
  const onResponse = async (response: Response) => {
    try {
      const url = response.url()
      if (!isAwsEndpoint(url)) return
      if (/\/problem\?(?:[^#]*&)?kind=audio(?:&|$|#)/.test(url)) {
        const body = (await response.json()) as { assets?: { audio?: unknown } }
        if (typeof body.assets?.audio === "string") state.audio = body.assets.audio
      } else if (/\/verify(?:\?|$)/.test(url)) {
        const body = (await response.json()) as VerifyBody
        state.verify = body
        const next = body.problem?.assets?.audio
        if (typeof next === "string") state.audio = next
      }
    } catch {}
  }

  page.on("response", onResponse)
  try {
    if (!(await hasAwsWafCaptchaWidget(page, Math.min(3000, remaining()), signal))) return false
    const frame = await widgetFrame(page)
    if (!frame) return false

    await useEnglish(frame, step(3000)).catch(() => {})
    if (await visible(frame, START)) await frame.locator(START).click({ timeout: step(3000) })
    if (!(await visible(frame, ANSWER))) {
      state.audio = undefined
      await frame.locator(AUDIO_TOGGLE).click({ timeout: step(5000) })
    }

    let submissions = 0
    for (let round = 0; round < MAX_ROUNDS && submissions < MAX_SUBMISSIONS; round++) {
      if (signal?.aborted || remaining() <= 0) return false
      const requestNew = async () => {
        state.audio = undefined
        await frame.locator(REFRESH).click({ timeout: step(3000) })
      }

      if (!(await until(() => state.audio !== undefined, step(8000), signal))) {
        await requestNew().catch(() => {})
        continue
      }
      const bytes = decodeAudio(state.audio ?? "")
      state.audio = undefined
      const transcript = bytes ? await transcribe(bytes, signal) : undefined
      const answer = transcript ? extractAwsWafAnswer(transcript) : undefined
      if (!answer) {
        await requestNew().catch(() => {})
        continue
      }

      state.verify = undefined
      await frame.locator(ANSWER).fill(answer, { timeout: step(3000) })
      await frame.locator(VERIFY).click({ timeout: step(3000) })
      submissions++
      if (!(await until(() => state.verify !== undefined, step(8000), signal))) return false
      // Read through a function: the assignment above would otherwise narrow this to `undefined`.
      const verdict = ((): VerifyBody | undefined => state.verify)()
      if (verdict?.success === true) {
        console.log(`[aws-waf] solved after ${submissions} submission(s)`)
        return true
      }
      // A rejected answer returns the next puzzle in the same response.
    }
    console.log(`[aws-waf] gave up after ${submissions} submission(s)`)
  } catch (err) {
    if (!signal?.aborted) console.log("[aws-waf] error:", err instanceof Error ? err.message : err)
  } finally {
    page.off("response", onResponse)
  }
  return false
}
