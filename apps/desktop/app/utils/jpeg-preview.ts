import { LocalizedError } from "./localization"
/** Bound decoded pixels before handing an untrusted remote JPEG to the WebView. */
export function jpegPreviewBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    throw new LocalizedError("ui.imageExceedsThePreviewLimit")
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  validateJpegPreview(bytes)
  return bytes
}

export function validateJpegPreview(bytes: Uint8Array, limits?: { width: number; height: number }): void {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new LocalizedError("ui.imageExceedsThe8MibPreviewLimit")
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new LocalizedError("ui.invalidJpegPreview")
  let offset = 2
  while (offset + 8 < Math.min(bytes.length, 65536)) {
    if (bytes[offset++] !== 0xff) break
    while (offset < 65536 && bytes[offset] === 0xff) offset++
    if (offset + 8 >= Math.min(bytes.length, 65536)) break
    const marker = bytes[offset++] ?? 0
    const size = (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0)
    if (size < 2 || offset + size > bytes.length) break
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = (bytes[offset + 3] ?? 0) * 256 + (bytes[offset + 4] ?? 0)
      const width = (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0)
      if (size < 8 || !height || !width || height > 16384 || width > 16384 || width * height > 16_000_000)
        throw new LocalizedError("ui.screenshotExceedsThe16MegapixelPreviewLimit")
      if (limits && (width > limits.width || height > limits.height))
        throw new LocalizedError("ui.screenshotExceedsTheAllowedPreviewDimensions")
      return
    }
    if (marker === 0xda || marker === 0xd9) break
    offset += size
  }
  throw new LocalizedError("ui.jpegDimensionsAreUnavailable")
}
