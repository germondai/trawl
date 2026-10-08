import { expect, test } from "bun:test"
import { matchGeetestPiece } from "../src/solvers/geetestImage"

function images() {
  const width = 160,
    height = 60,
    pw = 30,
    ph = 30,
    top = 15,
    target = 93
  const pixels = new Uint8Array(width * height * 4)
  let state = 37
  for (let i = 0; i < pixels.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    pixels[i] = state & 255
    pixels[i + 1] = (state >>> 8) & 255
    pixels[i + 2] = (state >>> 16) & 255
    pixels[i + 3] = 255
  }
  const tile = new Uint8Array(pw * ph * 4)
  for (let y = 4; y < ph - 4; y++)
    for (let x = 4; x < pw - 4; x++) {
      const from = ((top + y) * width + target + x) * 4,
        to = (y * pw + x) * 4
      tile.set(pixels.subarray(from, from + 4), to)
      for (let c = 0; c < 3; c++) pixels[from + c] = Math.round(pixels[from + c] * 0.6)
    }
  return { background: { width, height, pixels }, piece: { width: pw, height: ph, pixels: tile }, top, target }
}

test("finds a darkened cutout without counting transparent piece padding", () => {
  const { background, piece, top, target } = images()
  expect(matchGeetestPiece(background, piece, top)).toBe(target)
})

test("does not invent a match for a flat or transparent piece", () => {
  const { background, piece, top } = images()
  piece.pixels.fill(255)
  expect(matchGeetestPiece(background, piece, top)).toBeUndefined()
  piece.pixels.fill(0)
  expect(matchGeetestPiece(background, piece, top)).toBeUndefined()
})

test("rejects incomplete pixel buffers and out-of-bounds layouts", () => {
  const { background, piece } = images()
  expect(matchGeetestPiece(background, piece, -1)).toBeUndefined()
  expect(matchGeetestPiece(background, piece, background.height)).toBeUndefined()
  expect(matchGeetestPiece({ ...background, pixels: [] }, piece, 0)).toBeUndefined()
})

test("failed page inspection is never reported as GeeTest success", async () => {
  const { isGeetestSuccess } = await import("../src/solvers/geetest")
  const page = {
    evaluate: async () => {
      throw new Error("navigation")
    },
  }
  expect(await isGeetestSuccess(page as never)).toBe(false)
})
