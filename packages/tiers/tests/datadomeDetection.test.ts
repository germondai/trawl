import { describe, expect, test } from "bun:test"
import {
  detectChallengeType,
  getDataDomeAction,
  hasDataDomeCaptcha,
  hasDataDomeChallenge,
  isBlocked,
  isChallengeWall,
  isCloudflarePage,
  needsJs,
} from "../src/utils/detect"
import {
  DATADOME_CAPTCHA,
  DATADOME_HTML_HARD_BLOCK,
  DATADOME_INTERSTITIAL,
  DATADOME_JSON_CAPTCHA,
  DATADOME_JSON_HARD_BLOCK,
  DATADOME_TAGGED_PAGE,
} from "./fixtures/datadome"

describe("DataDome detection", () => {
  test("classifies the Device Check interstitial as a JS-solvable wall", () => {
    expect(getDataDomeAction(DATADOME_INTERSTITIAL)).toBe("interstitial")
    expect(detectChallengeType(DATADOME_INTERSTITIAL, {}, 403)).toBe("datadome")
    expect(isCloudflarePage(DATADOME_INTERSTITIAL, {})).toBe(false)
    expect(needsJs(DATADOME_INTERSTITIAL, {})).toBe(true)
    expect(isBlocked(403, DATADOME_INTERSTITIAL)).toBe(true)
    expect(isChallengeWall(403, DATADOME_INTERSTITIAL.length, "datadome")).toBe(true)
  })

  test("separates the interactive slider from the Device Check", () => {
    expect(getDataDomeAction(DATADOME_CAPTCHA)).toBe("captcha")
    expect(hasDataDomeCaptcha(DATADOME_CAPTCHA)).toBe(true)
    expect(hasDataDomeCaptcha(DATADOME_INTERSTITIAL)).toBe(false)
    expect(detectChallengeType(DATADOME_CAPTCHA)).toBe("datadome")
  })

  test("reads the hard block from the dd object, not only from the challenge URL", () => {
    expect(getDataDomeAction(DATADOME_HTML_HARD_BLOCK)).toBe("blocked")
    expect(hasDataDomeCaptcha(DATADOME_HTML_HARD_BLOCK)).toBe(false)
    expect(detectChallengeType(DATADOME_HTML_HARD_BLOCK, { "x-dd-b": "2" }, 403)).toBe("datadome")
  })

  test("reads the JSON block shape XHR requests receive", () => {
    expect(getDataDomeAction(DATADOME_JSON_CAPTCHA)).toBe("captcha")
    expect(getDataDomeAction(DATADOME_JSON_HARD_BLOCK)).toBe("blocked")
  })

  test("escalates on the x-dd-b header alone, before any body is read", () => {
    expect(getDataDomeAction("", { "X-DD-B": "1" })).toBe("interstitial")
    expect(detectChallengeType("", { "x-dd-b": "1" }, 403)).toBe("datadome")
  })

  test("does not classify an ordinary page carrying the client tag", () => {
    expect(hasDataDomeChallenge(DATADOME_TAGGED_PAGE)).toBe(false)
    expect(detectChallengeType(DATADOME_TAGGED_PAGE)).toBe("none")
    expect(needsJs(DATADOME_TAGGED_PAGE, {})).toBe(false)
  })

  test("does not classify a bare provider-domain mention", () => {
    expect(hasDataDomeChallenge("<p>Protected by captcha-delivery.com</p>")).toBe(false)
  })

  test("lets the authoritative Cloudflare header win", () => {
    expect(detectChallengeType(DATADOME_INTERSTITIAL, { "CF-Mitigated": "Challenge" })).toBe("cloudflare-interstitial")
  })
})
