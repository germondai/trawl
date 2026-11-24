// DataDome CAPTCHA solver.
//
// The interactive wall offers a slider and an accessibility alternative that plays a short
// clip reading six digits, typed one per box. An opt-in slider is tried first (datadomeSlider.ts);
// when it cannot be used or does not pass, the audio alternative is the fallback: the solver
// switches the widget to audio, reads the clip through the page's own network context,
// transcribes it and types the digits into the real widget, so the SDK builds its own request
// and telemetry. The audio path needs a recogniser that returns all six digits reliably (see
// STT_URL/STT_MODEL); the default public one often drops a repeated digit, in which case the
// puzzle is replaced instead of submitted.
//
// A turned-away session ("access restricted") ends the whole attempt: no second way of answering
// helps once DataDome has restricted the session.

import type { Frame, Page } from "patchright"
import { sleep } from "../utils/deadline"
import { DATADOME_DIGITS, extractDataDomeDigits } from "./datadomeAnswer"
import { SLIDER_HANDLE, type SliderPace, type SliderResult, solveDataDomeSlider } from "./datadomeSlider"
import { accepted, findFrame, hasWallFrame, isRestricted, present, settledAfterAccept } from "./datadomeWidget"
import { transcribeAudioBytes } from "./stt"

const AUDIO_BUTTON = "#captcha__audio__button"
const AUDIO_TRACK = "audio.audio-captcha-track"
const INPUTS = ".audio-captcha-inputs"
const SUBMIT = ".audio-captcha-submit-button"
const RELOAD = "#captcha__reload__button"
const PLAY = ".audio-captcha-play-button"
const PLAYBACK = `(() => {
  const a = document.querySelector("audio.audio-captcha-track")
  return !a || a.ended || (a.duration > 0 && a.currentTime >= a.duration - 0.3)
})()`
// DataDome's clips are 16 kHz mono 16-bit WAV: 32 000 bytes per second of speech.
const WAV_BYTES_PER_SECOND = 32_000
const MAX_LISTEN_MS = 30_000
// Only DataDome's own host may serve the clip: the URL comes from page markup.
const DD_HOST = /(?:^|\.)captcha-delivery\.com$/i

const MAX_SUBMISSIONS = 3
// Puzzles whose transcript has no usable answer are replaced without being submitted,
// so the number of rounds is bounded separately from the submissions.
const MAX_ROUNDS = 6
const MAX_AUDIO_BYTES = 2_000_000

export type DataDomeDownload = (page: Page, url: string, timeoutMs: number) => Promise<Uint8Array | undefined>

async function defaultDownload(page: Page, url: string, timeoutMs: number): Promise<Uint8Array | undefined> {
  // The context's own egress and cookies: a server-side fetch would leave the session.
  const response = await page.request.get(url, { timeout: Math.max(1, timeoutMs) })
  try {
    if (!response.ok()) return
    const body = await response.body()
    return body.length > 0 && body.length <= MAX_AUDIO_BYTES ? new Uint8Array(body) : undefined
  } finally {
    await response.dispose()
  }
}

async function widgetFrame(page: Page): Promise<Frame | undefined> {
  return findFrame(page, [AUDIO_BUTTON, INPUTS])
}

async function hasDataDomeWidget(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    if (signal?.aborted) return false
    if (await widgetFrame(page)) return true
    if (Date.now() >= deadline) break
    await sleep(Math.min(200, deadline - Date.now()), signal).catch(() => {})
  } while (Date.now() < deadline)
  return false
}

function isDataDomeAudio(src: string | null): src is string {
  if (!src) return false
  try {
    const url = new URL(src)
    return url.protocol === "https:" && DD_HOST.test(url.hostname)
  } catch {
    return false
  }
}

async function readAudioSrc(frame: Frame, timeout: number): Promise<string | undefined> {
  const src = await frame
    .locator(AUDIO_TRACK)
    .first()
    .getAttribute("src", { timeout })
    .catch(() => null)
  return isDataDomeAudio(src) ? src : undefined
}

// The clip is read in the widget's language and its path carries it: /audio/<date>/<lang>/<id>.wav.
export function audioLanguage(src: string): string {
  try {
    return /^\/audio\/[^/]+\/([a-z]{2})(?:[-_][a-z]{2})?\//i.exec(new URL(src).pathname)?.[1].toLowerCase() ?? "en"
  } catch {
    return "en"
  }
}

export interface Pace {
  // Pause between two digit boxes and before pressing Verify, in milliseconds [min, max].
  typing: [number, number]
  // How long a key stays down before the next one, in milliseconds [min, max].
  keystroke: [number, number]
  submit: [number, number]
  // How long to watch the widget after it flags a pass: DataDome can still turn the session
  // away in the same frame ("access restricted"), and that is not a solved wall.
  settle: number
}

const HUMAN_PACE: Pace = { typing: [120, 280], keystroke: [40, 100], submit: [500, 1100], settle: 6000 }

function between([min, max]: [number, number]): number {
  return min + Math.random() * Math.max(0, max - min)
}

// A person plays the clip and waits for it to end before typing; the widget reports the play
// and the time taken. Playing is best effort: without an audio device the element may never
// advance, so the wait is also bounded by the length the clip should take.
async function listen(
  frame: Frame,
  bytes: number,
  startedAt: number,
  deadline: number,
  signal: AbortSignal,
): Promise<"done" | "restricted"> {
  const lengthMs = Math.min(MAX_LISTEN_MS, (bytes / WAV_BYTES_PER_SECOND) * 1000 + 800)
  const until = Math.min(deadline, startedAt + lengthMs)
  while (Date.now() < until && !signal.aborted) {
    // DataDome can turn the session away while the clip plays; typing into a widget that is
    // already gone only ends in a timeout.
    if (await isRestricted(frame)) return "restricted"
    const ended = await frame.evaluate(PLAYBACK).catch(() => false)
    if (ended === true) return "done"
    await sleep(Math.min(300, Math.max(1, until - Date.now())), signal).catch(() => {})
  }
  return (await isRestricted(frame)) ? "restricted" : "done"
}

// The toggle animates, so a click can miss: the widget stays on the slider while the clip is
// still readable from the hidden <audio>. Confirm the digit boxes are showing before relying on
// the audio view, and click again when they are not.
async function openAudioView(frame: Frame, signal: AbortSignal, timeout: () => number): Promise<boolean> {
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    if (await present(frame, INPUTS)) return true
    await frame
      .locator(AUDIO_BUTTON)
      .click({ timeout: Math.max(1, Math.min(3000, timeout())), force: true })
      .catch(() => {})
    await sleep(Math.min(900, timeout()), signal).catch(() => {})
  }
  return present(frame, INPUTS)
}

async function solveAudio(
  page: Page,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  transcribe: typeof transcribeAudioBytes,
  download: DataDomeDownload,
  pace: Pace,
): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  const step = (cap: number) => Math.max(1, Math.min(cap, remaining()))

  try {
    if (!(await hasDataDomeWidget(page, Math.min(3000, remaining()), signal))) return false
    const first = await widgetFrame(page)
    if (!first || signal.aborted || remaining() <= 0) return false
    let frame: Frame = first

    let submissions = 0
    let previousSrc: string | undefined
    for (let round = 0; round < MAX_ROUNDS && submissions < MAX_SUBMISSIONS; round++) {
      if (signal.aborted || remaining() <= 0) return false
      if (await accepted(frame)) return true

      const requestNew = async () => {
        signal.throwIfAborted()
        await frame.locator(RELOAD).click({ timeout: step(3000) })
        await sleep(Math.min(800, remaining()), signal).catch(() => {})
      }

      // A reload can bring the slider back, so the audio panel is re-opened every round.
      signal.throwIfAborted()
      if (!(await openAudioView(frame, signal, remaining))) {
        await requestNew().catch(() => {})
        continue
      }

      // A reload is only confirmed once a new clip replaces the old one.
      let src: string | undefined
      const until = Math.min(deadline, Date.now() + 8000)
      while (Date.now() < until && !signal.aborted) {
        src = await readAudioSrc(frame, step(1000))
        if (src && src !== previousSrc) break
        src = undefined
        await sleep(Math.min(200, step(200)), signal).catch(() => {})
      }
      if (!src) {
        await requestNew().catch(() => {})
        continue
      }
      previousSrc = src

      // Play the clip like a person would; the download and transcription run while it plays.
      const playedAt = Date.now()
      // No `force` here: it skips the stability wait, and a click that lands while the widget is
      // still animating can hit the neighbouring toggle and flip the widget back to the slider.
      await frame
        .locator(PLAY)
        .first()
        .click({ timeout: step(3000) })
        .catch(() => {})
      const bytes = await download(page, src, step(10_000)).catch(() => undefined)
      signal.throwIfAborted()
      const transcript = bytes ? await transcribe(bytes, signal, "audio.wav", audioLanguage(src)) : undefined
      signal.throwIfAborted()
      const digits = transcript ? extractDataDomeDigits(transcript) : undefined
      if (!digits) {
        await requestNew().catch(() => {})
        continue
      }

      if ((await listen(frame, bytes?.length ?? 0, playedAt, deadline, signal)) === "restricted") {
        console.log(`[datadome] access restricted before the answer was typed (${submissions} submission(s))`)
        return false
      }
      // The widget can fall back to the slider while the clip plays; the clip is stale then.
      if (!(await openAudioView(frame, signal, remaining))) {
        await requestNew().catch(() => {})
        continue
      }
      const boxes = frame.locator(INPUTS)
      for (let i = 0; i < DATADOME_DIGITS; i++) {
        signal.throwIfAborted()
        // Real key events: the wall's own script records the typing, and fill() would set the value
        // with no keyboard activity at all. A pass without keystrokes is accepted by the widget and
        // then turned away by the site.
        await boxes.nth(i).click({ timeout: step(3000) })
        await page.keyboard.type(digits[i], { delay: between(pace.keystroke) })
        await sleep(Math.min(between(pace.typing), remaining()), signal).catch(() => {})
      }
      signal.throwIfAborted()
      await sleep(Math.min(between(pace.submit), remaining()), signal)
      await frame.locator(SUBMIT).click({ timeout: step(3000) })
      submissions++

      // Accepted by the widget: it flags the pass or unmounts. That is not clearance: the site
      // can still turn the next request away, so the caller confirms through the waiter.
      // Rejected: a different clip replaces this one.
      const verdictBy = Math.min(deadline, Date.now() + 8000)
      while (Date.now() < verdictBy && !signal.aborted) {
        if (await accepted(frame)) {
          if ((await settledAfterAccept(page, frame, pace.settle, signal, remaining)) === "restricted") {
            console.log(`[datadome] answer turned away after ${submissions} submission(s): access restricted`)
            return false
          }
          console.log(`[datadome] widget accepted the answer after ${submissions} submission(s)`)
          return true
        }
        if (frame.isDetached()) {
          // The page left the wall, or DataDome swapped in another wall page (a new puzzle, or
          // the "access restricted" page). Only the first one is a pass.
          if (!(await widgetFrame(page)) && !hasWallFrame(page)) {
            console.log(`[datadome] wall gone after ${submissions} submission(s)`)
            return true
          }
          const next = await widgetFrame(page)
          if (!next) {
            console.log(`[datadome] answer turned away after ${submissions} submission(s): access restricted`)
            return false
          }
          frame = next
          break
        }
        const now = await readAudioSrc(frame, step(500))
        if (now && now !== src) break
        await sleep(Math.min(250, step(250)), signal).catch(() => {})
      }
    }
    console.log(`[datadome] gave up after ${submissions} submission(s)`)
  } catch (err) {
    if (!signal?.aborted) console.log("[datadome] error:", err instanceof Error ? err.message : err)
  }
  return false
}

type SliderSolver = (page: Page, timeoutMs: number, signal?: AbortSignal) => Promise<SliderResult>

function sliderEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.DATADOME_SLIDER?.trim() ?? "")
}

// The slider gets at most this long: it either passes within a few drags or it will not.
const SLIDER_BUDGET_MS = 30_000

async function hasAnyWidget(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  do {
    if (signal?.aborted) return false
    if (await findFrame(page, [SLIDER_HANDLE, AUDIO_BUTTON, INPUTS])) return true
    if (Date.now() >= deadline) break
    await sleep(Math.min(200, deadline - Date.now()), signal).catch(() => {})
  } while (Date.now() < deadline)
  return false
}

export async function solveDataDome(
  page: Page,
  timeoutMs = 60_000,
  signal?: AbortSignal,
  // Injectable so the widget loops can be exercised without a recogniser or a network.
  transcribe: typeof transcribeAudioBytes = transcribeAudioBytes,
  download: DataDomeDownload = defaultDownload,
  pace: Pace = HUMAN_PACE,
  // Off unless DATADOME_SLIDER is set: under the pool's humanised mouse the drag does not finish in
  // time, and an aborted drag followed by the audio answer is not something a person does.
  slider: SliderSolver | undefined = sliderEnabled()
    ? (p, ms, s) => solveDataDomeSlider(p, ms, s, sliderPace)
    : undefined,
  sliderPace?: SliderPace,
): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  const deadline = Date.now() + timeoutMs
  const left = () => Math.max(0, deadline - Date.now())

  if (!(await hasAnyWidget(page, Math.min(3000, left()), signal))) {
    if (!signal?.aborted) console.log("[datadome] no widget on the wall (slider or audio): nothing to solve")
    return false
  }

  if (slider) {
    const result = await slider(page, Math.min(SLIDER_BUDGET_MS, Math.floor(left() / 2)), signal)
    if (result === "passed") return true
    // A restricted session cannot be recovered by answering another way.
    if (result === "restricted") return false
    if (signal?.aborted || left() <= 0) return false
  }
  return solveAudio(page, left(), signal, transcribe, download, pace)
}
