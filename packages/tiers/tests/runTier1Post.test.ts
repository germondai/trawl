import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { tier1Transport } from "../src/utils/tlsTransport"

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
  const originalFetch = tier1Transport.fetch
  tier1Transport.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const call: RecordedCall = { url, init }
    recorded.push(call)
    return responder(call)
  }) as typeof fetch
  return () => {
    tier1Transport.fetch = originalFetch
  }
}

beforeEach(() => {
  recorded.length = 0
})

afterEach(() => {
  // Per-test teardown is handled by the returned `restore` closure in each test.
})

describe("runTier1 — POST support", () => {
  test("reports the same fingerprint UA that the orchestrator sends", async () => {
    const restore = installFetchMock()
    try {
      const result = await scrape(
        { url: "https://example.com/x", maxTier: 1 },
        {
          acquireBrowser: async () => {
            throw new Error("Tier 1 success must not acquire a browser")
          },
          releaseBrowser: () => {},
          loadSession: async () => undefined,
          saveSession: async () => {},
          invalidateSession: async () => {},
        },
      )

      const headers = recorded[0].init?.headers as Record<string, string>
      expect(result.userAgent).toBe(headers["User-Agent"] ?? headers["user-agent"])
    } finally {
      restore()
    }
  })

  test("passes an explicit HTTP proxy to the TLS transport", async () => {
    const restore = installFetchMock()
    try {
      const result = await runTier1("https://target.example/x", undefined, undefined, undefined, "http://proxy:8080")
      expect(result.status).toBe("success")
      expect((recorded[0].init as RequestInit & { proxy?: string }).proxy).toBe("http://proxy:8080")
    } finally {
      restore()
    }
  })

  test("normalizes proxy authentication and Proxy-Status failures", async () => {
    let restore = installFetchMock(
      () => new Response("proxy auth", { status: 407, headers: { "content-type": "text/plain" } }),
    )
    try {
      const result = await runTier1("https://target.example/x", undefined, undefined, undefined, "http://proxy:8080")
      expect(result.status).toBe("error")
      expect(result.reason).toBe("proxy-authentication-failed")
    } finally {
      restore()
    }

    restore = installFetchMock(
      () =>
        new Response("upstream failed", {
          status: 502,
          headers: { "content-type": "text/plain", "proxy-status": "proxy.example; error=connection_timeout" },
        }),
    )
    try {
      const result = await runTier1("https://target.example/x", undefined, undefined, undefined, "http://proxy:8080")
      expect(result.status).toBe("error")
      expect(result.reason).toBe("proxy-connection-failed")
    } finally {
      restore()
    }
  })

  test("normalizes an explicit proxy transport failure", async () => {
    const restore = installFetchMock(() => {
      throw new Error("TLS connection aborted")
    })
    try {
      const result = await runTier1("https://target.example/x", undefined, undefined, undefined, "https://proxy:1001")
      expect(result.status).toBe("error")
      expect(result.reason).toBe("proxy-connection-failed")
    } finally {
      restore()
    }
  })

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
      const { sanitizeHeaders } = await import("../src/utils/sanitize")
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

  test("escalates a 200 Akamai interstitial while preserving raw response metadata", async () => {
    const html = '<html><div id="sec-if-cpt-container" class="behavioral-content"></div></html>'
    const restore = installFetchMock(
      () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "x-test": "akamai" },
        }),
    )
    try {
      const result = await runTier1("https://example.com/challenge")
      expect(result.status).toBe("needs-js")
      expect(result.reason).toBe("akamai-interstitial")
      expect(result.statusCode).toBe(200)
      expect(result.contentType).toBe("text/html; charset=utf-8")
      expect(result.responseHeaders?.["x-test"]).toBe("akamai")
      expect(new TextDecoder().decode(result.body)).toBe(html)
    } finally {
      restore()
    }
  })

  test("preserves multiple Set-Cookie fields without splitting Expires commas", async () => {
    const headers = new Headers({ "content-type": "text/html" })
    headers.append("set-cookie", "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/")
    headers.append("set-cookie", "clearance=two; Path=/; HttpOnly")
    const restore = installFetchMock(() => new Response("<html>OK</html>", { headers }))
    try {
      const result = await runTier1("https://example.com/")
      expect(result.responseHeaders?.["set-cookie"]).toBe(
        "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/\nclearance=two; Path=/; HttpOnly",
      )
    } finally {
      restore()
    }
  })
})
