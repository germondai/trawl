import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { audioLanguage, solveDataDome } from "../src/solvers/datadome"

const AUDIO_BUTTON = "#captcha__audio__button"
const AUDIO_TRACK = "audio.audio-captcha-track"
const INPUTS = ".audio-captcha-inputs"
const SUBMIT = ".audio-captcha-submit-button"
const RELOAD = "#captcha__reload__button"
const PLAY = ".audio-captcha-play-button"
const PASSED = '#analyticsCaptchaPassed[data-analytics-captcha-passed="true"]'

const clip = (n: number) => `https://dd.prod.captcha-delivery.com/audio/2026-11-14/en/clip${n}.wav`
const GOOD = "please type the numbers you hear 5 8. 9. 2. 4. 4."

// "gone": the wall left the page. "restricted": DataDome swapped the widget for its access-restricted page.
type Verdict = "accept" | "reject" | "gone" | "restricted" | "restricted-inline"

// No pauses: the pacing is a human-likeness concern, not something the loop logic depends on.
const NO_PACE: { typing: [number, number]; submit: [number, number]; settle: number } = {
  typing: [0, 0],
  submit: [0, 0],
  settle: 0,
}
const solve = (
  page: Page,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  transcribe: Parameters<typeof solveDataDome>[3],
  download?: Parameters<typeof solveDataDome>[4],
) => solveDataDome(page, timeoutMs, signal, transcribe, download, NO_PACE)

// A scripted stand-in for the widget: the audio panel opens on the toggle, every clip has its
// own URL, and each Verify click is answered from a list of verdicts. A rejection swaps in
// the next clip, the way the real widget does.
function fakeWidget(
  options: { verdicts?: Verdict[]; present?: boolean; audioHost?: string; restrictedWhilePlaying?: boolean } = {},
) {
  const log: string[] = []
  const typed: string[] = []
  const verdicts = [...(options.verdicts ?? ["accept"])]
  const state = { audio: false, clip: 1, passed: false, detached: false, restricted: false, inline: false }
  const srcOf = () => (options.audioHost ? `https://${options.audioHost}/a.wav` : clip(state.clip))

  const visible = (selector: string) => {
    if (options.present === false) return false
    if (selector === AUDIO_BUTTON) return !state.audio
    if (selector === INPUTS) return state.audio
    return false
  }

  const click = (selector: string) => {
    log.push(`click:${selector}`)
    if (selector === AUDIO_BUTTON) state.audio = true
    if (selector === RELOAD) state.clip++
    if (selector === SUBMIT) {
      const verdict = verdicts.shift() ?? "reject"
      if (verdict === "accept") state.passed = true
      else if (verdict === "restricted-inline") {
        // The widget flags the pass and then swaps its own content for the restricted page.
        state.passed = true
        state.inline = true
      } else if (verdict === "gone") state.detached = true
      else if (verdict === "restricted") {
        state.detached = true
        state.restricted = true
      } else state.clip++
    }
  }

  const locator = (selector: string, index = 0): unknown => ({
    first: () => locator(selector, 0),
    nth: (i: number) => locator(selector, i),
    isVisible: async () => visible(selector),
    count: async () => (selector === PASSED && state.passed ? 1 : 0),
    getAttribute: async (name: string) => (selector === AUDIO_TRACK && name === "src" ? srcOf() : null),
    click: async () => click(selector),
    textContent: async () => (state.inline ? "O acesso está temporariamente restrito" : "Digite os números"),
    fill: async (value: string) => {
      typed[index] = value
    },
  })

  const idle = (url: string) => ({
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    url: () => url,
  })
  const frame = {
    locator,
    isDetached: () => state.detached,
    // The playback probe: the session can be turned away while the clip is still playing.
    evaluate: async () => {
      if (options.restrictedWhilePlaying) {
        state.inline = true
        return false
      }
      return true
    },
    url: () => "https://geo.captcha-delivery.com/captcha/",
  }
  const page = {
    frames: () =>
      state.detached
        ? [
            idle("https://www.thefork.com/"),
            ...(state.restricted ? [idle("https://geo.captcha-delivery.com/captcha/")] : []),
          ]
        : [idle("https://www.thefork.com/"), frame],
  } as unknown as Page

  return { page, log, typed, state }
}

function recogniser(transcripts: Array<string | undefined>) {
  const files: string[] = []
  const fn = async (_bytes: Uint8Array, _signal?: AbortSignal, filename?: string) => {
    files.push(filename ?? "")
    return transcripts.shift()
  }
  return { fn, files }
}

const downloads: string[] = []
const download = async (_page: Page, url: string) => {
  downloads.push(url)
  return new Uint8Array([1, 2, 3])
}

describe("DataDome audio solver", () => {
  test("opens the audio panel, types the six digits and reports the accepted verdict", async () => {
    downloads.length = 0
    const widget = fakeWidget()
    const stt = recogniser([GOOD])

    expect(await solve(widget.page, 5000, undefined, stt.fn, download)).toBe(true)

    expect(widget.typed.join("")).toBe("589244")
    // The clip is played like a person would before the answer is typed.
    expect(widget.log).toEqual([`click:${AUDIO_BUTTON}`, `click:${PLAY}`, `click:${SUBMIT}`])
    expect(downloads).toEqual([clip(1)])
    // The clip is WAV: the recogniser must be told so.
    expect(stt.files).toEqual(["audio.wav"])
  })

  test("a rejected answer brings the next clip, solved with a fresh transcript", async () => {
    downloads.length = 0
    const widget = fakeWidget({ verdicts: ["reject", "accept"] })
    const stt = recogniser([GOOD, "please type the numbers you hear one two three four five six"])

    expect(await solve(widget.page, 5000, undefined, stt.fn, download)).toBe(true)

    expect(widget.typed.join("")).toBe("123456")
    expect(downloads).toEqual([clip(1), clip(2)])
  })

  test("replaces a clip whose transcript lacks six digits, without submitting it", async () => {
    const widget = fakeWidget()
    const stt = recogniser(["please type the numbers you hear five eight nine two four", undefined, GOOD])

    expect(await solve(widget.page, 5000, undefined, stt.fn, download)).toBe(true)

    expect(widget.log.filter((entry) => entry === `click:${RELOAD}`)).toHaveLength(2)
    expect(widget.log.filter((entry) => entry === `click:${SUBMIT}`)).toHaveLength(1)
  })

  test("gives up after three rejected answers", async () => {
    const widget = fakeWidget({ verdicts: ["reject", "reject", "reject", "accept"] })
    const stt = recogniser([GOOD, GOOD, GOOD, GOOD])

    expect(await solve(widget.page, 8000, undefined, stt.fn, download)).toBe(false)

    expect(widget.log.filter((entry) => entry === `click:${SUBMIT}`)).toHaveLength(3)
  })

  test("gives up when no transcript ever carries six digits, within a bounded number of clips", async () => {
    const widget = fakeWidget()
    const stt = recogniser(Array.from({ length: 10 }, () => "unrelated background narration"))

    expect(await solve(widget.page, 8000, undefined, stt.fn, download)).toBe(false)

    expect(widget.log).not.toContain(`click:${SUBMIT}`)
    expect(stt.files.length).toBeLessThanOrEqual(6)
  })

  test("ignores a clip that is not served by DataDome", async () => {
    downloads.length = 0
    const widget = fakeWidget({ audioHost: "evil.example" })
    const stt = recogniser([GOOD, GOOD, GOOD])

    expect(await solve(widget.page, 1500, undefined, stt.fn, download)).toBe(false)

    expect(downloads).toEqual([])
    expect(widget.log).not.toContain(`click:${SUBMIT}`)
  })

  test("counts the wall leaving the page after an answer as solved", async () => {
    const widget = fakeWidget({ verdicts: ["gone"] })

    expect(await solve(widget.page, 5000, undefined, recogniser([GOOD]).fn, download)).toBe(true)
  })

  test("does not count the access-restricted page that replaces the widget as solved", async () => {
    const widget = fakeWidget({ verdicts: ["restricted"] })

    expect(await solve(widget.page, 5000, undefined, recogniser([GOOD]).fn, download)).toBe(false)
  })

  test("does not count a pass the widget replaces with the access-restricted page in place", async () => {
    const widget = fakeWidget({ verdicts: ["restricted-inline"] })

    expect(await solve(widget.page, 5000, undefined, recogniser([GOOD]).fn, download)).toBe(false)
  })

  test("stops without typing when the session is turned away while the clip plays", async () => {
    const widget = fakeWidget({ restrictedWhilePlaying: true })

    expect(await solve(widget.page, 5000, undefined, recogniser([GOOD]).fn, download)).toBe(false)

    expect(widget.typed).toEqual([])
    expect(widget.log).not.toContain(`click:${SUBMIT}`)
  })

  test("returns false without touching anything when no widget is on the page", async () => {
    const widget = fakeWidget({ present: false })

    expect(await solve(widget.page, 300, undefined, recogniser([GOOD]).fn, download)).toBe(false)

    expect(widget.log).toEqual([])
  })

  test("does nothing once the request is aborted", async () => {
    const widget = fakeWidget()
    const controller = new AbortController()
    controller.abort()

    expect(await solve(widget.page, 5000, controller.signal, recogniser([GOOD]).fn, download)).toBe(false)

    expect(widget.log).toEqual([])
  })

  test("does not submit a transcript returned after cancellation", async () => {
    const widget = fakeWidget()
    const request = new AbortController()

    const solved = await solve(
      widget.page,
      5000,
      request.signal,
      async () => {
        request.abort()
        return GOOD
      },
      download,
    )

    expect(solved).toBe(false)
    expect(widget.typed).toEqual([])
    expect(widget.log).not.toContain(`click:${SUBMIT}`)
  })
})

describe("audioLanguage", () => {
  test("reads the language from the clip path", () => {
    expect(audioLanguage("https://dd.prod.captcha-delivery.com/audio/2026-11-15/pt/abc.wav")).toBe("pt")
    expect(audioLanguage("https://dd.prod.captcha-delivery.com/audio/2026-11-15/en/abc.wav")).toBe("en")
  })
  test("defaults to English for unknown paths", () => {
    expect(audioLanguage("https://dd.prod.captcha-delivery.com/clip.wav")).toBe("en")
    expect(audioLanguage("not a url")).toBe("en")
  })
})
