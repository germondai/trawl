import { expect, test } from "bun:test"
import { analyzeClickCaptcha } from "../src/solvers/shumeiImage"
import { runTier1 } from "../src/tiers/1"
import { detectChallengeType, hasShumei, needsJs } from "../src/utils/detect"
import { withFetch } from "./helpers/fetch"

test.each([
  "<p>Shumei captcha-sdk integration documentation</p>",
  '<script type="application/json">{"organization":"abcdefghijklmnopqrst"}</script>',
  '<script src="https://example.com/captcha-sdk.js"></script>',
  '<template><div class="smCaptcha"></div></template>',
])("does not classify references or inert markup as a Shumei widget: %s", (html) => {
  expect(hasShumei(html)).toBe(false)
})

test("routes an active Shumei widget to the browser with its provider type", () => {
  const html = '<div class="shumei_captcha_wrapper mode-spatial_select"></div>'
  expect(hasShumei(html)).toBe(true)
  expect(needsJs(html, {})).toBe(true)
  expect(detectChallengeType(html)).toBe("shumei")
})

test("does not return a Shumei shell as a completed HTTP scrape", async () => {
  await withFetch(
    new Response('<script src="/smcp.min.js"></script>', { headers: { "content-type": "text/html" } }),
    async () => {
      const result = await runTier1("https://example.com/widget")
      expect(result.status).toBe("needs-js")
      expect(result.challenge).toBe("shumei")
    },
  )
})

test("bounds image allocation and rejects unsupported spatial instructions", () => {
  for (const [width, height] of [
    [0, 1],
    [Infinity, 1],
    [1.5, 2],
    [10000, 10000],
    [10, 10],
  ]) {
    expect(analyzeClickCaptcha(new Uint8Array(4), width, height, ["点击图中最小的红色物体"]).target).toBeUndefined()
  }
  const pixels = new Uint8Array(40 * 40 * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255
    pixels[i + 3] = 255
  }
  expect(analyzeClickCaptcha(pixels, 40, 40, ["点击图中最小的红色物体"]).target).toBeDefined()
  for (const prompt of ["点击图中最大的红色物体", "点击红色和蓝色物体", "点击红色物体"]) {
    expect(analyzeClickCaptcha(pixels, 40, 40, [prompt]).target).toBeUndefined()
  }
})
