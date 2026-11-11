import { describe, expect, test } from "bun:test"
import { analyzeClickCaptcha } from "../src/solvers/shumeiImage"
import { hasShumei } from "../src/utils/detect"

describe("Shumei detection", () => {
  test("detects Shumei widget class markers", () => {
    expect(hasShumei('<div class="smCaptcha"></div>')).toBe(true)
    expect(hasShumei('<div class="sm-captcha"></div>')).toBe(true)
    expect(hasShumei('<button class="sm-button">Verify</button>')).toBe(false)
    expect(hasShumei('<div class="sm-slider"></div>')).toBe(false)
  })

  test("detects Shumei SDK script references", () => {
    expect(hasShumei('<script src="https://castatic.fengkongcloud.cn/pr/v1.0.4/smcp.min.js"></script>')).toBe(true)
    expect(hasShumei('<script src="https://www.ishumei.com/static/sdk.js"></script>')).toBe(false)
  })

  test("does not detect unrelated pages", () => {
    expect(hasShumei("<html><body>Hello world</body></html>")).toBe(false)
    expect(hasShumei('<div class="captcha"></div>')).toBe(false)
    expect(hasShumei("<script>console.log('hello')</script>")).toBe(false)
  })
})

describe("Shumei image analysis", () => {
  test("classifies pure red pixel correctly", () => {
    const pixels = new Uint8Array([255, 0, 0, 255])
    const result = analyzeClickCaptcha(pixels, 1, 1, ["红色"])
    expect(result.targetColor).toBe("红")
  })

  test("classifies pure green pixel correctly", () => {
    const pixels = new Uint8Array([0, 255, 0, 255])
    const result = analyzeClickCaptcha(pixels, 1, 1, ["绿色"])
    expect(result.targetColor).toBe("绿")
  })

  test("classifies pure blue pixel correctly", () => {
    const pixels = new Uint8Array([0, 0, 255, 255])
    const result = analyzeClickCaptcha(pixels, 1, 1, ["蓝色"])
    expect(result.targetColor).toBe("蓝")
  })

  test("detects color from order text variations", () => {
    expect(analyzeClickCaptcha(new Uint8Array(4), 1, 1, ["请点击红色物体"]).targetColor).toBe("红")
    expect(analyzeClickCaptcha(new Uint8Array(4), 1, 1, ["黄色"]).targetColor).toBe("黄")
    expect(analyzeClickCaptcha(new Uint8Array(4), 1, 1, ["橙色"]).targetColor).toBe("黄")
    expect(analyzeClickCaptcha(new Uint8Array(4), 1, 1, ["绿色"]).targetColor).toBe("绿")
    expect(analyzeClickCaptcha(new Uint8Array(4), 1, 1, ["青色"]).targetColor).toBe("绿")
    expect(analyzeClickCaptcha(new Uint8Array(4), 1, 1, ["蓝色"]).targetColor).toBe("蓝")
    expect(analyzeClickCaptcha(new Uint8Array(4), 1, 1, ["紫色"]).targetColor).toBe("蓝")
  })

  test("finds connected components in a colored region", () => {
    const width = 10
    const height = 10
    const pixels = new Uint8Array(width * height * 4)

    for (let y = 2; y < 8; y++) {
      for (let x = 2; x < 8; x++) {
        const i = (y * width + x) * 4
        pixels[i] = 255
        pixels[i + 1] = 0
        pixels[i + 2] = 0
        pixels[i + 3] = 255
      }
    }

    const result = analyzeClickCaptcha(pixels, width, height, ["点击图中最小的红色物体"], 0.1, 0.1, 10)
    expect(result.blobs.length).toBeGreaterThan(0)
    expect(result.blobs[0].color).toBe("红")
    expect(result.target).toBeDefined()
    expect(result.target?.color).toBe("红")
  })

  test("returns undefined target when no matching color found", () => {
    const width = 10
    const height = 10
    const pixels = new Uint8Array(width * height * 4)

    for (let y = 2; y < 8; y++) {
      for (let x = 2; x < 8; x++) {
        const i = (y * width + x) * 4
        pixels[i] = 255
        pixels[i + 1] = 0
        pixels[i + 2] = 0
        pixels[i + 3] = 255
      }
    }

    const result = analyzeClickCaptcha(pixels, width, height, ["点击图中最小的蓝色物体"], 0.1, 0.1, 10)
    expect(result.targetColor).toBe("蓝")
    expect(result.target).toBeUndefined()
  })
})
