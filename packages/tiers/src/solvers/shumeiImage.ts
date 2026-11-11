const HUB_HUES = [0, 38, 125, 208] as const
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
  for (const [name, words] of Object.entries(COLOR_WORDS)) {
    if (words.some((w) => text.includes(w))) return name
  }
  return undefined
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
  minArea = 250,
): AnalyzeResult {
  const colorMasks: Uint8Array[] = [
    new Uint8Array(width * height),
    new Uint8Array(width * height),
    new Uint8Array(width * height),
    new Uint8Array(width * height),
  ]

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [h, s, v] = rgbToHsv(pixels[i], pixels[i + 1], pixels[i + 2])
      if (s >= sMin && v >= vMin) {
        const hub = nearestHub(h)
        colorMasks[hub][y * width + x] = 1
      }
    }
  }

  const targetColor = detectTargetColor(order)
  const blobs: Blob[] = []

  for (let ci = 0; ci < 4; ci++) {
    const closed = morphClose(colorMasks[ci], width, height, 5)
    const labels = labelConnectedComponents(closed, width, height)
    const stats = new Map<number, { xs: number[]; ys: number[] }>()

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const lab = labels[y * width + x]
        if (!lab) continue
        let s = stats.get(lab)
        if (!s) {
          s = { xs: [], ys: [] }
          stats.set(lab, s)
        }
        s.xs.push(x)
        s.ys.push(y)
      }
    }

    for (const [, { xs, ys }] of stats) {
      if (xs.length < minArea) continue
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length
      const cy = ys.reduce((a, b) => a + b, 0) / ys.length
      const x0 = Math.min(...xs)
      const x1 = Math.max(...xs)
      const y0 = Math.min(...ys)
      const y1 = Math.max(...ys)
      blobs.push({
        color: HUB_NAMES[ci],
        area: xs.length,
        cx,
        cy,
        bx: (x0 + x1) / 2,
        by: (y0 + y1) / 2,
      })
    }
  }

  blobs.sort((a, b) => b.area - a.area)
  const candidates = targetColor ? blobs.filter((b) => b.color === targetColor) : []
  const target = candidates.length > 0 ? candidates.reduce((a, b) => (a.area < b.area ? a : b)) : undefined

  return { width, height, targetColor, blobs, target }
}
