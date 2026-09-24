import { describe, expect, test } from "bun:test"
import { parseLogLevel, safeMessage, safeUrl } from "./logger"

describe("operational logger", () => {
  test("defaults to info and validates configured levels", () => {
    expect(parseLogLevel(undefined)).toBe("info")
    expect(parseLogLevel(" DEBUG ")).toBe("debug")
    expect(() => parseLogLevel("verbose")).toThrow("Invalid LOG_LEVEL")
  })

  test("removes URL credentials, query parameters, and fragments", () => {
    expect(safeUrl("https://user:secret@example.com/search?passkey=secret#token")).toBe("https://example.com/search")
    expect(safeUrl("not a URL")).toBe("<unparseable-url>")
    expect(safeMessage("proxy http://user:secret@proxy.example:8080/path?token=secret failed")).toBe(
      "proxy http://proxy.example:8080/path failed",
    )
  })
})
