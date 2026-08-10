import { describe, expect, test } from "bun:test"
import type { Locator, Page } from "patchright"
import { extractAwsWafAudioAnswer, getAwsWafToken, solveAwsWafCaptcha } from "../src/solvers/awsWaf"
import { waitForAwsWafResolution } from "../src/utils/awsWafWait"
import {
  detectChallengeType,
  getAwsWafAction,
  hasAwsWafCaptcha,
  hasAwsWafInterstitial,
  isChallengeWall,
} from "../src/utils/detect"

const awsInterstitial = `<!doctype html>
<script>window.gokuProps = { key: "example" }</script>
<script src="https://abc123.captcha.awswaf.com/abc123/captcha.js"></script>
<div id="captcha-container"><button id="amzn-captcha-verify-button">Solve puzzle</button></div>`

describe("AWS WAF detection", () => {
  test("recognizes CAPTCHA and Challenge response headers case-insensitively", () => {
    expect(getAwsWafAction({ "X-Amzn-Waf-Action": " CAPTCHA " })).toBe("captcha")
    expect(getAwsWafAction({ "x-amzn-waf-action": "challenge" })).toBe("challenge")
    expect(detectChallengeType("", { "X-AMZN-WAF-ACTION": "captcha" })).toBe("aws-waf")
    expect(isChallengeWall(405, 0, "aws-waf")).toBe(true)
    expect(isChallengeWall(202, 0, "aws-waf")).toBe(true)
  })

  test("recognizes the full-page gokuProps interstitial", () => {
    expect(hasAwsWafInterstitial(awsInterstitial)).toBe(true)
    expect(detectChallengeType(awsInterstitial)).toBe("aws-waf")
  })

  test("keeps the embedded JS API separate from a full-page wall", () => {
    const embedded = `
      <script src="https://abc123.captcha.awswaf.com/abc123/jsapi.js"></script>
      <script>AwsWafCaptcha.renderCaptcha(document.querySelector("#captcha"), {})</script>`
    expect(hasAwsWafCaptcha(embedded)).toBe(true)
    expect(hasAwsWafInterstitial(embedded)).toBe(false)
  })

  test("does not flag an ordinary AWS SDK script", () => {
    const ordinary = '<script src="https://sdk.amazonaws.com/js/aws-sdk.min.js"></script>'
    expect(hasAwsWafInterstitial(ordinary)).toBe(false)
    expect(hasAwsWafCaptcha(ordinary)).toBe(false)
  })
})

type WidgetStage = "start" | "visual" | "audio" | "solved"

interface WidgetState {
  stage: WidgetStage
  answer?: string
  audioToggleClicked: boolean
  audioHidden?: boolean
  audioVersion?: number
  refreshClicks?: number
  submitted: boolean
}

class MockLocator {
  constructor(
    private readonly selector: string,
    private readonly state: WidgetState,
  ) {}

  first(): MockLocator {
    return this
  }

  async count(): Promise<number> {
    if (this.selector.includes("audio")) return this.state.stage === "audio" ? 1 : 0
    return 1
  }

  async isVisible(): Promise<boolean> {
    if (this.selector.includes(", ")) return this.state.stage !== "solved"
    if (this.selector.includes("amzn-captcha-verify-button")) return this.state.stage === "start"
    if (this.selector.includes("amzn-btn-audio-internal")) return this.state.stage === "visual"
    if (this.selector.includes("audio")) return this.state.stage === "audio" && !this.state.audioHidden
    if (this.selector.includes("input")) return this.state.stage === "audio"
    if (this.selector.includes("amzn-btn-verify-internal")) return this.state.stage === "audio"
    if (this.selector.includes("amzn-btn-refresh-internal")) return this.state.stage === "audio"
    return false
  }

  async waitFor(): Promise<void> {
    if (!(await this.isVisible())) throw new Error("not visible")
  }

  async click(): Promise<void> {
    if (this.selector.includes("amzn-captcha-verify-button")) this.state.stage = "visual"
    else if (this.selector.includes("amzn-btn-audio-internal")) {
      this.state.audioToggleClicked = true
      this.state.stage = "audio"
    } else if (this.selector.includes("amzn-btn-verify-internal")) {
      this.state.submitted = true
      this.state.stage = "solved"
    } else if (this.selector.includes("amzn-btn-refresh-internal")) {
      this.state.refreshClicks = (this.state.refreshClicks ?? 0) + 1
      this.state.audioVersion = (this.state.audioVersion ?? 0) + 1
    }
  }

  async fill(value: string): Promise<void> {
    this.state.answer = value
  }

  async evaluate(): Promise<string> {
    return `data:audio/aac;base64,${Buffer.from(`audio-${this.state.audioVersion ?? 0}`).toString("base64")}`
  }
}

function mockAwsPage(state: WidgetState): Page {
  const page = {
    url: () => "https://shop.example.com/product",
    locator: (selector: string) => new MockLocator(selector, state) as unknown as Locator,
    content: async () => (state.stage === "solved" ? "<html><body>Product</body></html>" : awsInterstitial),
    context: () => ({
      cookies: async () =>
        state.stage === "solved" ? [{ name: "aws-waf-token", value: "fresh-token", domain: ".example.com" }] : [],
    }),
    waitForLoadState: async () => {},
    goto: async () => null,
  }
  return page as unknown as Page
}

describe("AWS WAF CAPTCHA browser flow", () => {
  test("extracts one answer word from punctuated and unpunctuated AWS audio transcripts", () => {
    expect(extractAwsWafAudioAnswer("Type one of the two following words spoken by me. Influence. Monitor.")).toBe(
      "influence",
    )
    expect(
      extractAwsWafAudioAnswer(
        "because it would be deep one of the two following words spoken by me church that is company nature",
      ),
    ).toBe("church")
    expect(extractAwsWafAudioAnswer("type one of the two following words spoken by me a science from use")).toBe(
      "science",
    )
    expect(extractAwsWafAudioAnswer("a doctrine of the analysis height")).toBe("height")
    expect(extractAwsWafAudioAnswer("insecurities")).toBe("insecurities")
    expect(extractAwsWafAudioAnswer("type one of the two following words spoken by me")).toBeUndefined()
  })

  test("switches to audio, transcribes, submits, and observes the token", async () => {
    const state: WidgetState = {
      stage: "start",
      audioToggleClicked: false,
      audioHidden: true,
      submitted: false,
    }
    const page = mockAwsPage(state)
    let transcribedSource = ""

    const solved = await solveAwsWafCaptcha(page, 5_000, {
      sleep: async () => {},
      transcribe: async (source) => {
        transcribedSource = source
        return "Type one of the two following words spoken by me. Blue. Seven."
      },
    })

    expect(solved).toBe(true)
    expect(state.audioToggleClicked).toBe(true)
    expect(state.answer).toBe("blue")
    expect(state.submitted).toBe(true)
    expect(transcribedSource).toStartWith("data:audio/aac;base64,")
    expect(await getAwsWafToken(page, "shop.example.com")).toBe("fresh-token")
  })

  test("reads Eventbrite's hidden audio element and refreshes after each empty transcript", async () => {
    const state: WidgetState = {
      stage: "start",
      audioToggleClicked: false,
      audioHidden: true,
      audioVersion: 0,
      refreshClicks: 0,
      submitted: false,
    }
    let transcriptionAttempts = 0

    const solved = await solveAwsWafCaptcha(mockAwsPage(state), 5_000, {
      maxAttempts: 3,
      sleep: async () => {},
      transcribe: async (source) => {
        transcriptionAttempts++
        expect(source).toStartWith("data:audio/aac;base64,")
        return undefined
      },
    })

    expect(solved).toBe(false)
    expect(transcriptionAttempts).toBe(3)
    expect(state.refreshClicks).toBe(3)
    expect(state.submitted).toBe(false)
  })

  test("full-page waiter invokes the solver and waits for a stable cleared page", async () => {
    const state: WidgetState = { stage: "visual", audioToggleClicked: false, submitted: false }
    const page = mockAwsPage(state)
    let calls = 0

    const result = await waitForAwsWafResolution(page, 5_000, page.url(), () => ({}), {
      sleep: async () => {},
      solveCaptcha: async () => {
        calls++
        state.stage = "solved"
        return true
      },
    })

    expect(result).toEqual({ status: "ok", captchaSolved: true })
    expect(calls).toBe(1)
  })

  test("zero timeout returns without touching the page", async () => {
    const state: WidgetState = { stage: "visual", audioToggleClicked: false, submitted: false }
    const result = await waitForAwsWafResolution(mockAwsPage(state), 0)
    expect(result).toEqual({ status: "timeout", captchaSolved: false })
    expect(state.stage).toBe("visual")
  })
})
