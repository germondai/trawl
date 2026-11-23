import { expect, test } from "bun:test"
import { isAndroidUserAgent } from "../app/utils/android-user-agent"

test("distinguishes Android WebView from WebKitGTK desktop", () => {
  expect(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel Build/AP3A; wv) AppleWebKit/537.36")).toBe(true)
  expect(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 12; TV; wv) AppleWebKit/537.36 TRAWL-TV")).toBe(true)
  expect(isAndroidUserAgent("Mozilla/5.0 (Linux; like Android 4.4) AppleWebKit/605.1.15")).toBe(false)
})
