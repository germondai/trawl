import { describe, expect, test } from "bun:test"
import { runTier1 } from "../src/tiers/1"
import { installFetchMock } from "./helpers/fetch"

const htmlResponse = (html: string) =>
  new Response(html, {
    status: 200,
    headers: { "content-type": "text/html" },
  })

describe("runTier1 — full body on success (regression #46)", () => {
  test("returns the complete html for text responses larger than the 4 KiB detection preview", async () => {
    // Only closing marker sits at the very end, far past the preview window —
    // a truncated body cannot contain it.
    const filler = `<p>${"x".repeat(100)}</p>\n`.repeat(300)
    const html = `<html><body>${filler}<div id="the-end">done</div></body></html>`
    expect(html.length).toBeGreaterThan(4096 * 2)
    const restore = installFetchMock(() => htmlResponse(html))
    try {
      const result = await runTier1("https://example.com/large")
      expect(result.status).toBe("success")
      expect(result.html).toBe(html)
      expect(new TextDecoder().decode(result.body)).toBe(html)
    } finally {
      restore()
    }
  })

  test("a multi-byte character straddling the preview boundary decodes intact", async () => {
    // '€' is 3 bytes in UTF-8 and starts at byte 4095, so the bounded preview
    // cuts it mid-sequence (this is why #46 saw cuts at 4093-4096, not always
    // exactly 4096). The success body must decode from the full buffer and
    // keep the character intact.
    const html = `${"a".repeat(4095)}€ tail beyond the preview window`
    const restore = installFetchMock(() => htmlResponse(html))
    try {
      const result = await runTier1("https://example.com/boundary")
      expect(result.status).toBe("success")
      expect(result.html).toBe(html)
      expect(result.html).toContain("€ tail")
    } finally {
      restore()
    }
  })

  test("responses that fit inside the preview window are returned unchanged", async () => {
    const html = "<html><body>small</body></html>"
    const restore = installFetchMock(() => htmlResponse(html))
    try {
      const result = await runTier1("https://example.com/small")
      expect(result.status).toBe("success")
      expect(result.html).toBe(html)
    } finally {
      restore()
    }
  })

  test("returns the complete html for text responses larger than the 64 KiB detection preview", async () => {
    const filler = `<p>${"x".repeat(100)}</p>\n`.repeat(800)
    const html = `<html><body>${filler}<div id="the-end">done</div></body></html>`
    expect(html.length).toBeGreaterThan(65536)
    const restore = installFetchMock(() => htmlResponse(html))
    try {
      const result = await runTier1("https://example.com/very-large")
      expect(result.status).toBe("success")
      expect(result.html).toBe(html)
      expect(new TextDecoder().decode(result.body)).toBe(html)
    } finally {
      restore()
    }
  })

  test("detects challenges positioned past the legacy 4 KiB boundary", async () => {
    const filler = `<!-- filler ${"x".repeat(100)} -->\n`.repeat(45)
    const html = `<html><head><title>Captcha</title></head><body>${filler}<script type="module" src="/js/page_specific/altcha.js"></script></body></html>`
    expect(html.indexOf("altcha.js")).toBeGreaterThan(4096)
    expect(html.length).toBeLessThan(65536)
    const restore = installFetchMock(() => htmlResponse(html))
    try {
      const result = await runTier1("https://example.com/altcha-deep")
      expect(result.status).toBe("needs-js")
      expect(result.challenge).toBe("altcha")
    } finally {
      restore()
    }
  })
})
