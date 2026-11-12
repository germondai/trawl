import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { solveAwsWaf } from "../src/solvers/awsWaf"

const START = "#amzn-captcha-verify-button"
const VERIFY = "#amzn-btn-verify-internal"
const AUDIO_TOGGLE = "#amzn-btn-audio-internal"
const REFRESH = "#amzn-btn-refresh-internal"
const ANSWER = "#amzn-captcha-audio-answer"
const LANG_SELECT = "#amzn-captcha-lang-select"
const LANG_APPLY = ".amzn-captcha-lang-apply"

const AWS = "https://abc.us-east-1.captcha.awswaf.com/abc/def/ghi"
// Decodes to a few bytes; the injected recogniser ignores the content.
const AUDIO = "AAAA"
const GOOD = "Type one of the two following words spoken by me. target. knowledge."

type Verdict = { success: boolean; nextAudio?: string }

// A scripted stand-in for the widget: it reveals the answer box after the audio toggle,
// serves puzzles through the same response events the real SDK produces, and answers
// each Confirm click from a list of verdicts.
function fakeWidget(options: { verdicts?: Verdict[]; lang?: string; present?: boolean; foreign?: boolean } = {}) {
  const log: string[] = []
  const answers: string[] = []
  const verdicts = [...(options.verdicts ?? [{ success: true }])]
  const handlers = new Set<(response: unknown) => Promise<void> | void>()
  const widget = { started: false, audio: false, lang: options.lang ?? "en" }

  const emit = (url: string, body: unknown) => {
    for (const handler of handlers) handler({ url: () => url, json: async () => body })
  }

  const visible = (selector: string) => {
    if (options.present === false) return false
    if (selector === START) return !widget.started
    if (selector === VERIFY) return widget.started
    if (selector === ANSWER) return widget.audio
    return false
  }

  const click = (selector: string) => {
    log.push(`click:${selector}`)
    if (selector === START) widget.started = true
    if (selector === AUDIO_TOGGLE) {
      widget.audio = true
      emit(`${AWS}/problem?kind=audio&domain=x&locale=en-us`, { assets: { audio: AUDIO } })
    }
    if (selector === REFRESH) emit(`${AWS}/problem?kind=audio&domain=x&locale=en-us`, { assets: { audio: AUDIO } })
    if (selector === VERIFY) {
      // A page may expose its own /verify; its JSON is not AWS's verdict.
      if (options.foreign) emit("https://example.test/verify?x=1", { success: true })
      const verdict = verdicts.shift() ?? { success: false }
      emit(`${AWS}/verify?region=us-east-1`, {
        success: verdict.success,
        problem: verdict.nextAudio ? { assets: { audio: verdict.nextAudio } } : null,
      })
    }
  }

  const locator = (selector: string) => ({
    first: () => locator(selector),
    isVisible: async () => visible(selector),
    count: async () => (selector === LANG_SELECT && options.present !== false ? 1 : 0),
    inputValue: async () => widget.lang,
    selectOption: async (value: string) => {
      widget.lang = value
      log.push(`lang:${value}`)
    },
    click: async () => click(selector),
    fill: async (value: string) => {
      answers.push(value)
    },
  })

  const frame = { locator }
  const page = {
    frames: () => [{ locator: () => ({ first: () => ({ isVisible: async () => false }) }) }, frame],
    on: (_event: string, handler: (response: unknown) => Promise<void> | void) => handlers.add(handler),
    off: (_event: string, handler: (response: unknown) => Promise<void> | void) => handlers.delete(handler),
  } as unknown as Page

  return { page, log, answers, handlers }
}

function recogniser(transcripts: Array<string | undefined>) {
  const calls: number[] = []
  const fn = async () => {
    calls.push(calls.length)
    return transcripts.shift()
  }
  return { fn, calls }
}

describe("AWS WAF audio solver", () => {
  test("opens the widget, switches to English, types the first word and reports the accepted verdict", async () => {
    const widget = fakeWidget({ lang: "pt" })
    const stt = recogniser([GOOD])

    expect(await solveAwsWaf(widget.page, 5000, undefined, stt.fn)).toBe(true)

    expect(widget.answers).toEqual(["target"])
    expect(widget.log).toEqual([
      "lang:en",
      `click:${LANG_APPLY}`,
      `click:${START}`,
      `click:${AUDIO_TOGGLE}`,
      `click:${VERIFY}`,
    ])
  })

  test("leaves the language alone when the widget is already in English", async () => {
    const widget = fakeWidget({ lang: "en" })

    await solveAwsWaf(widget.page, 5000, undefined, recogniser([GOOD]).fn)

    expect(widget.log.some((entry) => entry.startsWith("lang:"))).toBe(false)
  })

  test("a rejected answer brings the next puzzle, which is solved with a fresh transcript", async () => {
    const widget = fakeWidget({ verdicts: [{ success: false, nextAudio: AUDIO }, { success: true }] })
    const stt = recogniser([GOOD, "Type one of the two following words spoken by me: counter, statistics."])

    expect(await solveAwsWaf(widget.page, 5000, undefined, stt.fn)).toBe(true)

    expect(widget.answers).toEqual(["target", "counter"])
    expect(stt.calls).toHaveLength(2)
  })

  test("replaces a puzzle whose transcript has no usable answer without submitting it", async () => {
    const widget = fakeWidget()
    const stt = recogniser(["type one of the two following words spoken by me.", undefined, GOOD])

    expect(await solveAwsWaf(widget.page, 5000, undefined, stt.fn)).toBe(true)

    expect(widget.log.filter((entry) => entry === `click:${REFRESH}`)).toHaveLength(2)
    expect(widget.answers).toEqual(["target"])
  })

  test("does not treat another site's /verify as the verdict", async () => {
    const widget = fakeWidget({ foreign: true, verdicts: [{ success: false, nextAudio: AUDIO }, { success: true }] })
    const stt = recogniser([GOOD, GOOD])

    expect(await solveAwsWaf(widget.page, 5000, undefined, stt.fn)).toBe(true)

    // The foreign success on the first click must not have ended the run early.
    expect(widget.answers).toHaveLength(2)
  })

  test("gives up after three rejected answers", async () => {
    const rejected = { success: false, nextAudio: AUDIO }
    const widget = fakeWidget({ verdicts: [rejected, rejected, rejected, { success: true }] })
    const stt = recogniser([GOOD, GOOD, GOOD, GOOD])

    expect(await solveAwsWaf(widget.page, 5000, undefined, stt.fn)).toBe(false)

    expect(widget.answers).toHaveLength(3)
  })

  test("gives up when no transcript ever carries an answer", async () => {
    const widget = fakeWidget()
    const stt = recogniser(Array.from({ length: 10 }, () => "unrelated background narration"))

    expect(await solveAwsWaf(widget.page, 5000, undefined, stt.fn)).toBe(false)

    expect(widget.answers).toEqual([])
    // Bounded: it asks for a handful of new puzzles, not an endless stream.
    expect(stt.calls.length).toBeLessThanOrEqual(6)
  })

  test("returns false without touching anything when no widget is on the page", async () => {
    const widget = fakeWidget({ present: false })

    expect(await solveAwsWaf(widget.page, 300, undefined, recogniser([GOOD]).fn)).toBe(false)

    expect(widget.log).toEqual([])
  })

  test("does nothing once the request is aborted", async () => {
    const widget = fakeWidget()
    const controller = new AbortController()
    controller.abort()

    expect(await solveAwsWaf(widget.page, 5000, controller.signal, recogniser([GOOD]).fn)).toBe(false)

    expect(widget.log).toEqual([])
  })

  test("cancels a stalled transcription within the local budget without refreshing the widget", async () => {
    const widget = fakeWidget()
    const request = new AbortController()
    const guard = setTimeout(() => request.abort(), 500)
    try {
      const solved = await solveAwsWaf(widget.page, 40, request.signal, async (_bytes, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return undefined
      })

      expect(solved).toBe(false)
      expect(request.signal.aborted).toBe(false)
      expect(widget.log).not.toContain(`click:${REFRESH}`)
      expect(widget.answers).toEqual([])
      expect(widget.handlers.size).toBe(0)
    } finally {
      clearTimeout(guard)
    }
  })

  test("does not submit a transcript returned after cancellation", async () => {
    const widget = fakeWidget()
    const request = new AbortController()

    const solved = await solveAwsWaf(widget.page, 5000, request.signal, async () => {
      request.abort()
      return GOOD
    })

    expect(solved).toBe(false)
    expect(widget.answers).toEqual([])
    expect(widget.log).not.toContain(`click:${VERIFY}`)
    expect(widget.handlers.size).toBe(0)
  })

  test("always detaches its response listener", async () => {
    const solved = fakeWidget()
    await solveAwsWaf(solved.page, 5000, undefined, recogniser([GOOD]).fn)
    expect(solved.handlers.size).toBe(0)

    const failed = fakeWidget({ verdicts: [{ success: false }] })
    await solveAwsWaf(failed.page, 400, undefined, recogniser([GOOD]).fn)
    expect(failed.handlers.size).toBe(0)
  })
})
