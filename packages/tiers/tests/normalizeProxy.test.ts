import { describe, expect, test } from "bun:test"
import { normalizeProxy } from "../src/utils/proxyRotator"

// Covers issue #12: Prowlarr's Cardigann flow serializes `proxy` as an object
// {url, username, password}; other callers send a plain URL string. The API
// boundary must normalize both into a single URL string before the orchestrator
// hands the value to Playwright/Camoufox `newContext({proxy})` (which requires
// `server` to be a string).
describe("normalizeProxy", () => {
  describe("nullish / empty inputs", () => {
    test("undefined → undefined", () => {
      expect(normalizeProxy(undefined)).toBeUndefined()
    })

    test("null → undefined", () => {
      expect(normalizeProxy(null)).toBeUndefined()
    })

    test("empty string → undefined", () => {
      expect(normalizeProxy("")).toBeUndefined()
    })

    test("whitespace-only string → undefined", () => {
      expect(normalizeProxy("   ")).toBeUndefined()
    })

    test("empty object → undefined", () => {
      expect(normalizeProxy({})).toBeUndefined()
    })

    test("object with neither url nor server → undefined", () => {
      expect(normalizeProxy({ username: "u", password: "p" })).toBeUndefined()
    })
  })

  describe("plain URL string (legacy / non-Prowlarr callers)", () => {
    test("passes a simple URL through unchanged", () => {
      expect(normalizeProxy("http://proxy.example.com:8080")).toBe("http://proxy.example.com:8080")
    })

    test("trims surrounding whitespace", () => {
      expect(normalizeProxy("  http://proxy.example.com:8080  ")).toBe("http://proxy.example.com:8080")
    })

    test("preserves embedded credentials in URL string", () => {
      expect(normalizeProxy("http://user:pass@proxy.example.com:8080")).toBe("http://user:pass@proxy.example.com:8080")
    })
  })

  describe("Prowlarr object form {url, username, password}", () => {
    test("object with only url → returns url as-is", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080" })).toBe("http://proxy.example.com:8080")
    })

    test("object with url + username + password → embeds credentials in URL", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080", username: "alice", password: "secret" })).toBe(
        "http://alice:secret@proxy.example.com:8080",
      )
    })

    test("object with url + username (no password) → embeds username only", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080", username: "alice" })).toBe(
        "http://alice:@proxy.example.com:8080",
      )
    })

    test("object with url + password (no username) → embeds password only", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080", password: "secret" })).toBe(
        "http://:secret@proxy.example.com:8080",
      )
    })

    test("object with empty-string username/password → returns url as-is", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080", username: "", password: "" })).toBe(
        "http://proxy.example.com:8080",
      )
    })
  })

  describe("alternate object form {server, ...}", () => {
    test("accepts `server` field in place of `url`", () => {
      expect(normalizeProxy({ server: "http://proxy.example.com:8080" })).toBe("http://proxy.example.com:8080")
    })

    test("prefers `url` over `server` when both are present", () => {
      expect(
        normalizeProxy({ url: "http://primary.example.com:8080", server: "http://fallback.example.com:8080" }),
      ).toBe("http://primary.example.com:8080")
    })
  })

  describe("credential encoding", () => {
    test("URL-encodes '@' in password", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080", username: "alice", password: "p@ss" })).toBe(
        "http://alice:p%40ss@proxy.example.com:8080",
      )
    })

    test("URL-encodes ':' in password", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080", username: "alice", password: "pa:ss" })).toBe(
        "http://alice:pa%3Ass@proxy.example.com:8080",
      )
    })

    test("URL-encodes special characters in username", () => {
      expect(normalizeProxy({ url: "http://proxy.example.com:8080", username: "user@org", password: "secret" })).toBe(
        "http://user%40org:secret@proxy.example.com:8080",
      )
    })

    test("preserves https scheme", () => {
      expect(normalizeProxy({ url: "https://proxy.example.com:443", username: "u", password: "p" })).toBe(
        "https://u:p@proxy.example.com:443",
      )
    })

    test("preserves socks5 scheme", () => {
      expect(normalizeProxy({ url: "socks5://proxy.example.com:1080", username: "u", password: "p" })).toBe(
        "socks5://u:p@proxy.example.com:1080",
      )
    })
  })

  describe("malformed inputs (defensive)", () => {
    test("server-only object with no recognised fields → undefined", () => {
      expect(normalizeProxy({ username: "u", password: "p" })).toBeUndefined()
    })

    test("non-string url field → undefined", () => {
      expect(normalizeProxy({ url: 42 as unknown as string })).toBeUndefined()
    })
  })
})
