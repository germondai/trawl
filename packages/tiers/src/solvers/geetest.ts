import { sleep } from "../utils/deadline"
// GeeTest slide solver: match piece texture, recalculate live popup geometry,
// drag the handle and require an explicit completed state.

import { randomUUID } from "node:crypto"
import { unlink } from "node:fs/promises"
import type { Page } from "patchright"
import { matchGeetestPiece } from "./geetestImage"
import { runFfmpeg } from "./subprocess"

// Initial "Click to verify" button selectors (GeeTest v4 entry point).
// Use aria-label and specific class — avoid [class*="geetest_btn"] which also matches the icon SVG.
const VERIFY_BUTTON = [
  'div[aria-label="Click to verify"]',
  "div.geetest_btn_click",
  ".geetest_btn_click",
  ".geetest_wind_style",
  ".geetest_radar_tip",
  ".gt_ajax_tip",
].join(", ")

// Legacy v3 handles; v4 uses the button inside its slider.
const DRAG_HANDLE_V3 = ".geetest_slider_button, .gt_slider_knob"

type Box = { x: number; y: number; width: number; height: number }

async function visibleBox(page: Page, selector: string, deadline: number): Promise<Box | undefined> {
  if (Date.now() >= deadline) return undefined
  return page
    .evaluate((sel) => {
      for (const el of document.querySelectorAll(sel)) {
        const box = el.getBoundingClientRect()
        if (box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden")
          return { x: box.x, y: box.y, width: box.width, height: box.height }
      }
    }, selector)
    .catch(() => undefined)
}

export async function solveGeetestSlide(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs
  try {
    if (await isGeetestSuccess(page)) return true
    const mountedUntil = Math.min(deadline, Date.now() + 5000)
    while (Date.now() < mountedUntil) {
      if (await isGeetestSuccess(page)) return true
      const verify = await visibleBox(page, VERIFY_BUTTON, deadline)
      if (verify) {
        await page.mouse.click(verify.x + verify.width / 2, verify.y + verify.height / 2)
        break
      }
      if (await visibleBox(page, ".geetest_bg, .geetest_canvas_bg, .gt_cut_bg", deadline)) break
      await sleep(150, signal)
    }

    for (let attempt = 0; attempt < 3 && Date.now() < deadline && !signal.aborted; attempt++) {
      let image: Box | undefined, piece: Box | undefined, handle: Box | undefined
      const readyUntil = Math.min(deadline, Date.now() + 5000)
      let previous: Box[] | undefined
      while (Date.now() < readyUntil) {
        if (await isGeetestSuccess(page)) return true
        image = await visibleBox(page, ".geetest_bg, .geetest_canvas_bg, .gt_cut_bg", deadline)
        piece = await visibleBox(page, ".geetest_slice, .geetest_canvas_slice, .gt_slice", deadline)
        handle = await visibleBox(page, `${DRAG_HANDLE_V3}, .geetest_slider .geetest_btn`, deadline)
        if (image && piece && handle) {
          const boxes = [image, piece, handle]
          const stable = previous?.every((old, i) =>
            Object.keys(old).every((key) => Math.abs(old[key as keyof Box] - boxes[i][key as keyof Box]) < 0.5),
          )
          if (stable) break
          previous = boxes
        }
        await sleep(150, signal)
      }
      if (!image || !piece || !handle) return false

      const images = await readGeetestImages(page, Math.min(2500, deadline - Date.now()))
      const match = images ? matchGeetestPiece(images.background, images.piece, images.top) : undefined
      // The popup animates while its images decode. Use the live geometry for
      // input coordinates and scale the match from the sampled image dimensions.
      image = await visibleBox(page, ".geetest_bg, .geetest_canvas_bg, .gt_cut_bg", deadline)
      piece = await visibleBox(page, ".geetest_slice, .geetest_canvas_slice, .gt_slice", deadline)
      handle = await visibleBox(page, `${DRAG_HANDLE_V3}, .geetest_slider .geetest_btn`, deadline)
      if (!image || !piece || !handle) return false
      const gap =
        match !== undefined
          ? image.x + (match * image.width) / (images?.background.width ?? image.width) - piece.x
          : await findSliderGapByScreenshot(page, handle, image, piece.width / 2, signal)
      const track = await visibleBox(page, ".geetest_slider, .geetest_slider_track, .gt_slider", deadline)
      const ratio = track ? (track.width - handle.width) / (image.width - piece.width) : 1
      const distance = gap * ratio
      if (!Number.isFinite(distance) || distance <= 0 || (track && distance > track.width - handle.width + 2))
        return false
      console.log(
        `[geetest] attempt ${attempt + 1}, drag ${Math.round(distance)}px (${match === undefined ? "screenshot" : "texture"})`,
      )
      const startX = handle.x + handle.width / 2,
        startY = handle.y + handle.height / 2
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      try {
        for (let i = 1; i <= 12; i++) {
          if (Date.now() >= deadline || signal.aborted) return false
          const t = i / 12
          await page.mouse.move(startX + distance * easeInOut(t), startY + Math.sin(t * Math.PI) * 3, { steps: 1 })
          await sleep(15 + Math.random() * 15, signal)
        }
      } finally {
        await page.mouse.up().catch(() => {})
      }

      const resultUntil = Math.min(deadline, Date.now() + 4000)
      while (Date.now() < resultUntil) {
        if (await isGeetestSuccess(page)) return true
        const retry = await page
          .locator(".geetest_result_tips")
          .first()
          .textContent({ timeout: 200 })
          .catch(() => "")
        if (/try again|failed|incorrect/i.test(retry ?? "")) break
        await sleep(200, signal)
      }
      if (attempt < 2) {
        // Refresh changes the puzzle. Re-read geometry and recalculate its gap.
        const refresh = await visibleBox(page, ".geetest_refresh, .gt_refresh_button", deadline)
        if (!refresh) return false
        await page.mouse.click(refresh.x + refresh.width / 2, refresh.y + refresh.height / 2)
        await sleep(1000, signal)
      }
    }
    return false
  } catch (err) {
    console.log("[geetest] error:", err instanceof Error ? err.message : err)
    return false
  }
}

async function readGeetestImages(page: Page, timeout: number) {
  if (timeout <= 0) return undefined
  return page
    .evaluate(async (timeoutMs) => {
      const bg = document.querySelector<HTMLElement>(".geetest_bg")
      const piece = document.querySelector<HTMLElement>(".geetest_slice_bg")
      if (!bg || !piece) return
      const rect = bg.getBoundingClientRect(),
        tile = piece.getBoundingClientRect()
      if (
        rect.width < 1 ||
        rect.height < 1 ||
        tile.width < 1 ||
        tile.height < 1 ||
        rect.width * rect.height > 1_000_000
      )
        return
      const read = (el: HTMLElement, width: number, height: number) =>
        new Promise<{ width: number; height: number; pixels: number[] } | undefined>((resolve) => {
          const url = /^url\(["']?(.*?)["']?\)$/.exec(getComputedStyle(el).backgroundImage)?.[1]
          if (!url) {
            resolve(undefined)
            return
          }
          const img = new Image()
          const finish = (value?: { width: number; height: number; pixels: number[] }) => {
            clearTimeout(timer)
            img.onload = null
            img.onerror = null
            resolve(value)
          }
          const timer = setTimeout(() => finish(), timeoutMs)
          img.crossOrigin = "anonymous"
          img.onerror = () => finish()
          img.onload = () => {
            try {
              const canvas = document.createElement("canvas")
              canvas.width = Math.round(width)
              canvas.height = Math.round(height)
              const ctx = canvas.getContext("2d")
              if (!ctx) {
                finish()
                return
              }
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
              finish({
                width: canvas.width,
                height: canvas.height,
                pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
              })
            } catch {
              finish()
            }
          }
          // Browser loading preserves the context's proxy and outbound request policy.
          img.src = url
        })
      const [background, image] = await Promise.all([
        read(bg, rect.width, rect.height),
        read(piece, tile.width, tile.height),
      ])
      if (background && image) return { background, piece: image, top: Math.round(tile.y - rect.y) }
    }, timeout)
    .catch(() => undefined)
}

async function findSliderGapByScreenshot(
  page: Page,
  sliderBox: { x: number; y: number; width: number; height: number },
  svgBox: { x: number; y: number; width: number; height: number },
  pieceHalfW = 27,
  signal?: AbortSignal,
): Promise<number> {
  const id = randomUUID().slice(0, 8)
  const pngPath = `/tmp/gt-${id}.png`
  const rawPath = `/tmp/gt-${id}.raw`

  try {
    // Screenshot the SVG challenge image — this is where the notch is
    const clip = { x: svgBox.x, y: svgBox.y, width: svgBox.width, height: svgBox.height }

    const png = await page.screenshot({ clip })
    await Bun.write(pngPath, png)

    const ff = await runFfmpeg(
      ["-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-threads", "1", rawPath, "-y", "-loglevel", "error"],
      signal,
    )
    if (ff.exitCode !== 0) {
      console.log("[geetest] ffmpeg failed")
      return fallback(sliderBox)
    }

    const rawData = new Uint8Array(await Bun.file(rawPath).arrayBuffer())
    const w = Math.round(svgBox.width)
    const h = Math.round(svgBox.height)
    if (rawData.length < w * h * 3) {
      console.log("[geetest] raw pixel data too small")
      return fallback(sliderBox)
    }

    // Analyze pixel brightness column by column.
    // The notch is a puzzle-piece-shaped shadow region — distinctly darker than the rest.
    // The puzzle piece starts at the left — skip it (half of its width + small margin).
    const PIECE_W = Math.round(pieceHalfW * 2 + 10) // skip puzzle piece area at left
    const yStart = Math.floor(h * 0.15)
    const yEnd = Math.floor(h * 0.85)

    const edgeScore: number[] = new Array(w).fill(0)
    const avgBright: number[] = new Array(w).fill(0)

    for (let y = yStart; y < yEnd; y++) {
      for (let x = 2; x < w - 2; x++) {
        const iL = (y * w + (x - 2)) * 3
        const iC = (y * w + x) * 3
        const iR = (y * w + (x + 2)) * 3
        const bL = (rawData[iL] + rawData[iL + 1] + rawData[iL + 2]) / 3
        const bC = (rawData[iC] + rawData[iC + 1] + rawData[iC + 2]) / 3
        const bR = (rawData[iR] + rawData[iR + 1] + rawData[iR + 2]) / 3
        edgeScore[x] += Math.abs(bL - bR)
        avgBright[x] += bC
      }
    }
    const rows = yEnd - yStart
    for (let x = 0; x < w; x++) avgBright[x] /= rows

    // Darkest column in [PIECE_W, w-30] — center of the notch shadow
    let minBright = Number.POSITIVE_INFINITY
    let darkX = 0
    for (let x = PIECE_W; x < w - 30; x++) {
      if (avgBright[x] < minBright) {
        minBright = avgBright[x]
        darkX = x
      }
    }

    // Strongest edge in [PIECE_W, w-30] — notch boundary
    let maxEdge = 0
    let edgeX = 0
    for (let x = PIECE_W; x < w - 30; x++) {
      if (edgeScore[x] > maxEdge) {
        maxEdge = edgeScore[x]
        edgeX = x
      }
    }

    // Top peaks for diagnostics
    const peaks = Array.from({ length: w }, (_, x) => ({ x, s: edgeScore[x] }))
      .filter((p) => p.x >= PIECE_W && p.x <= w - 30)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
    console.log(`[geetest] dark notch x=${darkX}(bright=${Math.round(minBright)}) edge notch x=${edgeX}`)
    console.log("[geetest] top edge peaks:", peaks.map((p) => `x=${p.x}(${Math.round(p.s)})`).join(" "))

    // Use dark column as primary (consistent across runs), edge as fallback
    const notchCenterX = darkX || edgeX
    if (notchCenterX === 0) {
      console.log("[geetest] notch not found")
      return fallback(sliderBox)
    }

    // CENTER alignment: piece center should be at notch center.
    // After drag by gapX: piece center = sliderBox.x + pieceHalfW + gapX = svgBox.x + notchCenterX
    // gapX = svgBox.x + notchCenterX - sliderBox.x - pieceHalfW  (pieceHalfW = parameter)
    const gapX = svgBox.x + notchCenterX - sliderBox.x - pieceHalfW

    console.log(
      `[geetest] notch at svg-x=${notchCenterX} (page-x=${Math.round(svgBox.x + notchCenterX)}), drag=${Math.round(gapX)}`,
    )
    return Math.max(10, gapX)
  } catch (err) {
    console.log("[geetest] screenshot analysis error:", err instanceof Error ? err.message : err)
    return fallback(sliderBox)
  } finally {
    await Promise.all([pngPath, rawPath].map((path) => unlink(path).catch(() => {})))
  }
}

function fallback(_sliderBox: { x: number; y: number; width: number; height: number }): number {
  console.log("[geetest] using fallback gap 120px")
  return 120
}

export async function isGeetestSuccess(page: Page): Promise<boolean> {
  // A hidden popup can mean failure, reset or close. Require an explicit
  // completed widget state, not a permanent success icon hidden in its markup.
  return page
    .evaluate(() =>
      Array.from(
        document.querySelectorAll(
          ".geetest_captcha.geetest_lock_success, .geetest_holder.geetest_success, .gt_success, .geetest_success_radar_tip",
        ),
      ).some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"),
    )
    .catch(() => false)
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

export async function hasGeetestSlide(page: Page, timeout = 2000): Promise<boolean> {
  const html = await page.content().catch(() => "")
  if (/geetest|initGeetest|gt_container/i.test(html)) return true
  return page
    .waitForSelector(VERIFY_BUTTON, { timeout, state: "attached" })
    .then(() => true)
    .catch(() => false)
}
