import { t } from "./localization"
/** Format remote diagnostics without traversing arbitrarily deep or wide response data. */
export function jsonPreview(value: unknown, limit = 128 * 1024): string {
  let remaining = limit
  let nodes = 2000
  const seen = new WeakSet<object>()
  function bounded(input: unknown, depth: number): unknown {
    if (--nodes < 0 || remaining <= 0 || depth > 10) return `[${t("preview.limitedMarker")}]`
    remaining -= 16
    if (typeof input === "string") {
      const size = Math.min(input.length, Math.max(remaining, 0), 16384)
      remaining -= size
      return input.length > size ? `${input.slice(0, size)}… [${t("preview.limitedMarker")}]` : input
    }
    if (input === null || typeof input !== "object") return input
    if (seen.has(input)) return `[${t("preview.repeatedValue")}]`
    seen.add(input)
    if (Array.isArray(input)) {
      const result: unknown[] = []
      for (let index = 0; index < input.length; index++) {
        if (nodes <= 0 || remaining <= 0 || index >= 1000) {
          result.push(`[${t("preview.limitedMarker")}]`)
          break
        }
        result.push(bounded(input[index], depth + 1))
      }
      return result
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue
      if (nodes <= 0 || remaining <= 0) {
        result[`[${t("preview.limitedMarker")}]`] = true
        break
      }
      remaining -= key.length
      result[key.slice(0, 256)] = bounded((input as Record<string, unknown>)[key], depth + 1)
    }
    return result
  }
  try {
    return (JSON.stringify(bounded(value, 0), null, 2) ?? "null").slice(0, limit)
  } catch {
    return t("ui.diagnosticsCouldNotBeFormatted")
  }
}
