import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runTier1 } from "../src/tier1"

interface RecordedCall {
  url: string
  init: RequestInit | undefined
}

const recorded: RecordedCall[] = []

const installFetchMock = (
  responder: (req: RecordedCall) => Response = () => {
    return new Response("<html>OK</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  },
) => {
  const originalFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const call: RecordedCall = { url, init }
    recorded.push(call)
    return responder(call)
  }) as typeof fetch
  return () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  }
}

beforeEach(() => {
  recorded.length = 0
})

afterEach(() => {
  // Per-test teardown is handled by the returned `restore` closure in each test.
})

describe("runTier1 — POST support", () => {
  test("uses GET with no body when method is omitted", async () => {
    const restore = installFetchMock()
    try {
      const result = await runTier1("https://example.com/x")
      expect(result.status).toBe("success")
      expect(recorded).toHaveLength(1)
      expect(recorded[0].url).toBe("https://example.com/x")
      expect(recorded[0].init?.method).toBe("GET")
      expect(recorded[0].init?.body).toBeUndefined()
    } finally {
      restore()
    }
  })

  test("forwards method=POST and the body string to fetch", async () => {
    const restore = installFetchMock()
    try {
      const headers = { "Content-Type": "application/x-www-form-urlencoded" }
      const result = await runTier1("https://example.com/login", headers, "POST", "user=a&pw=b")
      expect(result.status).toBe("success")
      expect(recorded).toHaveLength(1)
      expect(recorded[0].url).toBe("https://example.com/login")
      expect(recorded[0].init?.method).toBe("POST")
      expect(recorded[0].init?.body).toBe("user=a&pw=b")
      // Caller-supplied Content-Type must be passed through untouched — no
      // auto-injection at the tier level.
      const h = recorded[0].init?.headers as Record<string, string>
      expect(h?.["Content-Type"] ?? h?.["content-type"]).toBe("application/x-www-form-urlencoded")
    } finally {
      restore()
    }
  })

  test("explicit method=GET still produces no body even when a body string is given", async () => {
    const restore = installFetchMock()
    try {
      await runTier1("https://example.com/x", undefined, "GET", "ignored=by-design")
      expect(recorded).toHaveLength(1)
      expect(recorded[0].init?.method).toBe("GET")
      // Spec: `method === "POST" ? body : undefined` — GET + body is ignored.
      expect(recorded[0].init?.body).toBeUndefined()
    } finally {
      restore()
    }
  })

  test("caller headers are spread LAST and therefore can override Fingerprint defaults — the reserved-name denylist at the orchestrator level is what prevents UA spoofing in production", async () => {
    const restore = installFetchMock()
    try {
      // This demonstrates the tier's pass-through behaviour: a non-reserved
      // header does override. Reserved headers are stripped upstream by
      // sanitizeHeaders(); this test pins both halves of the contract.
      const { sanitizeHeaders } = await import("../src/sanitize")
      const cleaned = sanitizeHeaders({ "User-Agent": "evil-spider/1.0", Accept: "application/json" })
      expect(cleaned).toEqual({ Accept: "application/json" }) // UA was reserved, dropped

      await runTier1("https://example.com/x", cleaned)
      const h = recorded[0].init?.headers as Record<string, string>
      // After sanitisation, only Accept survived — so tier1's FINGERPRINT UA wins.
      expect(h?.["User-Agent"] ?? h?.["user-agent"]).not.toBe("evil-spider/1.0")
      expect(h?.["User-Agent"] ?? h?.["user-agent"]).toBeTruthy()
    } finally {
      restore()
    }
  })

  test("non-2xx, non-CF response surfaces as blocked", async () => {
    const restore = installFetchMock(
      () =>
        new Response("<html>nope</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    )
    try {
      const result = await runTier1("https://example.com/x")
      expect(result.status).toBe("blocked")
      expect((result as { reason: string }).reason).toBe("http-403")
    } finally {
      restore()
    }
  })
})
