import { describe, expect, test } from "bun:test"
import { audioFilename, googleSampleRates, inferAudioContentType, selectGoogleTranscript } from "../src/solvers/stt"

describe("audio CAPTCHA speech-to-text", () => {
  test("preserves AWS AAC MIME and filename information from a data URL", () => {
    const source = "data:audio/aac;base64,/9AA"
    expect(inferAudioContentType(source)).toBe("audio/aac")
    expect(audioFilename(inferAudioContentType(source))).toBe("audio.aac")
  })

  test("sniffs AAC when an upstream response omits Content-Type", () => {
    expect(inferAudioContentType("blob:https://example.com/id", "", new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe(
      "audio/aac",
    )
  })

  test("keeps native 16 kHz first for AWS/AAC and the reCAPTCHA 8 kHz fallback order otherwise", () => {
    expect(googleSampleRates("audio/aac", "aws-waf")).toEqual([16_000, 8_000])
    expect(googleSampleRates("audio/mpeg", "generic")).toEqual([8_000, 16_000])
  })

  test("selects the AWS-aware alternative instead of Google's misleading top result", () => {
    const transcript = selectGoogleTranscript(
      [
        { transcript: "type one of the two following words spoken by me", confidence: 0.98 },
        { transcript: "type one of the two following words spoken by me approach" },
        { transcript: "because it would be nice", confidence: 0.97 },
        { transcript: "because it would be deep spoken by me and church", confidence: 0.91 },
        { transcript: "do not type one of the two following words spoken by me other words", confidence: 0.99 },
        {
          transcript: "type one of the two following words spoken by me church and again",
          confidence: 0.84,
        },
      ],
      "aws-waf",
    )
    expect(transcript).toBe("type one of the two following words spoken by me church and again")
  })

  test("preserves the first Google alternative for non-AWS challenges", () => {
    expect(
      selectGoogleTranscript(
        [
          { transcript: "Blue Seven", confidence: 0.8 },
          { transcript: "unrelated", confidence: 0.99 },
        ],
        "generic",
      ),
    ).toBe("blue seven")
  })
})
