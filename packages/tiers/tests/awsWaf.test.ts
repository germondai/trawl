import { describe, expect, test } from "bun:test"
import { detectChallengeType, hasAwsWafChallenge, isChallengeWall } from "../src/utils/detect"

// Minimal AWS WAF JS-challenge page — the real page loads challenge.js from
// token.awswaf.com and sets an aws-waf-token cookie before redirecting.
const awsWafInterstitial = `
  <!DOCTYPE html>
  <html>
    <head><title>Request unsuccessful</title></head>
    <body>
      <script>
        window.awsWafCookieDomainList = ['example.com'];
        window.gokuProps = {"key":"AQIDAHjcYu0fake","iv":"abc123==","context":"def456=="};
      </script>
      <script src="https://abc123.token.awswaf.com/abc123/challenge.js" defer></script>
    </body>
  </html>
`

describe("AWS WAF challenge detection", () => {
  test("detects the JS-challenge interstitial by awsWafCookieDomainList", () => {
    expect(hasAwsWafChallenge(awsWafInterstitial)).toBe(true)
    expect(detectChallengeType(awsWafInterstitial)).toBe("aws-waf")
  })

  test("detects the interstitial by gokuProps alone", () => {
    const html = `<html><body><script>window.gokuProps = {"key":"AQI"}</script></body></html>`
    expect(hasAwsWafChallenge(html)).toBe(true)
  })

  test("detects the interstitial by challenge.js script src", () => {
    const html = `<html><body><script src="https://x.token.awswaf.com/x/challenge.js"></script></body></html>`
    expect(hasAwsWafChallenge(html)).toBe(true)
  })

  test("does not flag a full page that merely loads AWS resources", () => {
    const html = `<html><body>${"real content ".repeat(400)}<script src="https://sdk.amazonaws.com/js/aws-sdk-2.0.0.min.js"></script></body></html>`
    expect(hasAwsWafChallenge(html)).toBe(false)
    expect(detectChallengeType(html)).toBe("none")
  })

  test("treats an AWS WAF interstitial as a proxy challenge wall", () => {
    expect(isChallengeWall(200, Buffer.byteLength(awsWafInterstitial), "aws-waf")).toBe(true)
  })

  test("treats a 202 response with empty body as a challenge wall regardless of type", () => {
    // AWS WAF returns HTTP 202 with a 0-byte body as a bot-gate before the JS
    // challenge page. isBlocked() already handles this for /scrape; isChallengeWall()
    // now matches so the MITM proxy path escalates consistently.
    expect(isChallengeWall(202, 0, "none")).toBe(true)
  })

  test("does not flag a non-empty 202 as a challenge wall", () => {
    // A legitimate 202 Accepted with a response body must not be escalated.
    expect(isChallengeWall(202, 512, "none")).toBe(false)
  })
})
