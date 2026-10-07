export interface RgbaImage {
  width: number
  height: number
  pixels: ArrayLike<number>
}

// Match the piece's texture against its horizontal row in the background.
// Correlation tolerates the dark overlay on the cutout; transparent padding and
// the piece's border must not contribute to the match.
export function matchGeetestPiece(background: RgbaImage, piece: RgbaImage, top: number): number | undefined {
  const { width: w, height: h, pixels: bg } = background
  const { width: pw, height: ph, pixels: tile } = piece
  if (w * h > 1_000_000 || pw * ph > 100_000 || pw < 5 || ph < 5 || pw >= w || top < 0 || top + ph > h) return undefined
  if (bg.length !== w * h * 4 || tile.length !== pw * ph * 4) return undefined

  const samples: { x: number; y: number; value: number }[] = []
  const brightness = (pixels: ArrayLike<number>, i: number) =>
    0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
  for (let y = 2; y < ph - 2; y += 2) {
    for (let x = 2; x < pw - 2; x += 2) {
      // Erode the alpha mask by two pixels to exclude antialiasing and borders.
      if ([-2, 0, 2].some((dy) => [-2, 0, 2].some((dx) => tile[((y + dy) * pw + x + dx) * 4 + 3] < 250))) continue
      samples.push({ x, y, value: brightness(tile, (y * pw + x) * 4) })
    }
  }
  if (samples.length < 20) return undefined
  const mean = samples.reduce((sum, p) => sum + p.value, 0) / samples.length
  const variance = samples.reduce((sum, p) => sum + (p.value - mean) ** 2, 0)
  if (variance < samples.length * 4) return undefined

  let bestScore = 0.5
  let bestX: number | undefined
  for (let x = Math.max(5, Math.floor(pw / 2)); x <= w - pw; x++) {
    let sum = 0,
      squared = 0,
      covariance = 0
    for (const p of samples) {
      const value = brightness(bg, ((top + p.y) * w + x + p.x) * 4)
      sum += value
      squared += value * value
      covariance += (p.value - mean) * value
    }
    const bgVariance = squared - (sum * sum) / samples.length
    const score = bgVariance > 0 ? covariance / Math.sqrt(variance * bgVariance) : 0
    if (score > bestScore) {
      bestScore = score
      bestX = x
    }
  }
  return bestX
}
