import type { RequestFile } from "./request-body"
export interface RequestField {
  enabled: boolean
  key: string
  value: string
  description: string
  file?: RequestFile
}
export type FieldFormat = "headers" | "query"
export const emptyRequestField = (): RequestField => ({ enabled: true, key: "", value: "", description: "" })

export function parseRequestFields(text: string, format: FieldFormat): RequestField[] {
  let pairs: [string, string][]
  if (format === "headers") {
    const value = JSON.parse(text || "{}")
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((v) => typeof v !== "string")
    )
      throw new Error("Headers must be a JSON object with string values")
    pairs = Object.entries(value)
  } else pairs = [...new URLSearchParams(text.split("\n").filter(Boolean).join("&"))]
  if (pairs.length > 100) throw new Error("Use at most 100 field rows")
  return pairs.map(([key, value]) => ({ enabled: true, key, value, description: "" }))
}

export function serializeRequestFields(rows: RequestField[], format: FieldFormat): string {
  const active = rows.filter((row) => row.enabled && !row.file && (row.key || row.value))
  if (format === "headers") {
    const names = new Set<string>()
    for (const row of active) {
      const name = row.key.toLowerCase()
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(row.key) || /[\r\n\0]/.test(row.value))
        throw new Error("Use a valid header name and a single-line value")
      if (names.has(name)) throw new Error("Header names must be unique (case-insensitive)")
      names.add(name)
    }
    return JSON.stringify(Object.fromEntries(active.map((row) => [row.key, row.value])), null, 2)
  }
  return new URLSearchParams(active.map((row) => [row.key, row.value])).toString()
}
