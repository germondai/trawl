const HUB_HUES = [0, 38, 125, 208] as const
export const MAX_SHUMEI_PIXELS = 262_144
const HUB_NAMES = ["红", "黄", "绿", "蓝"] as const
const COLOR_WORDS: Record<string, string[]> = {
  红: ["红"],
  黄: ["黄", "橙"],
  绿: ["绿", "青"],
  蓝: ["蓝", "紫"],
}

interface Blob {
  color: string
  area: number
  cx: number
  cy: number
  bx: number
  by: number
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  const s = max > 0 ? d / max : 0
  return [h, s, max]
}

function nearestHub(hue: number): number {
  let best = 0
  let bestDist = 360
  for (let i = 0; i < HUB_HUES.length; i++) {
    let d = Math.abs(hue - HUB_HUES[i])
    if (d > 180) d = 360 - d
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

function detectTargetColor(order: string[]): string | undefined {
  const text = order.join(" ")
  const matches = Object.entries(COLOR_WORDS).filter(([, words]) => words.some((word) => text.includes(word)))
  return matches.length === 1 ? matches[0][0] : undefined
}

function labelConnectedComponents(mask: Uint8Array, width: number, height: number): Uint32Array {
  const labels = new Uint32Array(width * height)
  let nextLabel = 1
  const parent = new Uint32Array(width * height + 1)
  for (let i = 0; i <= width * height; i++) parent[i] = i

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }

  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!mask[i]) continue
      const up = y > 0 && mask[i - width] ? labels[i - width] : 0
      const left = x > 0 && mask[i - 1] ? labels[i - 1] : 0
      if (up && left) {
        labels[i] = Math.min(up, left)
        union(up, left)
      } else if (up) {
        labels[i] = up
      } else if (left) {
        labels[i] = left
      } else {
        labels[i] = nextLabel++
      }
    }
  }

  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) labels[i] = find(labels[i])
  }
  return labels
}

function morphClose(mask: Uint8Array, width: number, height: number, size: number): Uint8Array {
  const dilated = new Uint8Array(mask.length)
  const half = Math.floor(size / 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let found = false
      outer: for (let dy = -half; dy <= half && !found; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const ny = y + dy
          const nx = x + dx
          if (ny >= 0 && ny < height && nx >= 0 && nx < width && mask[ny * width + nx]) {
            found = true
            break outer
          }
        }
      }
      dilated[y * width + x] = found ? 1 : 0
    }
  }
  const eroded = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let all = true
      outer: for (let dy = -half; dy <= half && all; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const ny = y + dy
          const nx = x + dx
          if (ny < 0 || ny >= height || nx < 0 || nx >= width || !dilated[ny * width + nx]) {
            all = false
            break outer
          }
        }
      }
      eroded[y * width + x] = all ? 1 : 0
    }
  }
  return eroded
}

export interface AnalyzeResult {
  width: number
  height: number
  targetColor: string | undefined
  blobs: Blob[]
  target: Blob | undefined
}

export function analyzeClickCaptcha(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  order: string[],
  sMin = 0.35,
  vMin = 0.1,
  minArea = Math.max(12, Math.round((width * height) / 400)),
): AnalyzeResult {
  const targetColor = detectTargetColor(order)
  const empty = { width, height, targetColor, blobs: [], target: undefined }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_SHUMEI_PIXELS ||
    pixels.length !== width * height * 4 ||
    !targetColor
  )
    return empty
  // Only the smallest-color puzzle is supported; other spatial instructions need a different classifier.
  if (!/最小|\bsmallest\b/i.test(order.join(" "))) return empty
  const color = HUB_NAMES.indexOf(targetColor as (typeof HUB_NAMES)[number])
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) {
    const [h, s, v] = rgbToHsv(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2])
    if (pixels[i * 4 + 3] >= 128 && s >= sMin && v >= vMin && nearestHub(h) === color) mask[i] = 1
  }
  const labels = labelConnectedComponents(morphClose(mask, width, height, 5), width, height)
  const stats = new Map<
    number,
    { area: number; sx: number; sy: number; x0: number; x1: number; y0: number; y1: number }
  >()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = labels[y * width + x]
      if (!label) continue
      let stat = stats.get(label)
      if (!stat) {
        stat = { area: 0, sx: 0, sy: 0, x0: x, x1: x, y0: y, y1: y }
        stats.set(label, stat)
      }
      stat.area++
      stat.sx += x
      stat.sy += y
      stat.x0 = Math.min(stat.x0, x)
      stat.x1 = Math.max(stat.x1, x)
      stat.y0 = Math.min(stat.y0, y)
      stat.y1 = Math.max(stat.y1, y)
    }
  }
  const blobs: Blob[] = []
  for (const stat of stats.values()) {
    if (stat.area < minArea) continue
    blobs.push({
      color: targetColor,
      area: stat.area,
      cx: stat.sx / stat.area,
      cy: stat.sy / stat.area,
      bx: (stat.x0 + stat.x1) / 2,
      by: (stat.y0 + stat.y1) / 2,
    })
  }
  blobs.sort((a, b) => a.area - b.area)
  return { width, height, targetColor, blobs, target: blobs[0] }
}
