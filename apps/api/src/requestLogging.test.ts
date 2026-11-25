import { describe, expect, spyOn, test } from "bun:test"
import { type OrchestratorDeps, ScrapeError } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult, TierResult } from "@trawl/types"
import { applyDomainProfile, refreshDomainProfile } from "./domainProfile"
import { MetricsStore } from "./metrics"
import { runLoggedScrape } from "./requestLogging"

const deps = (): OrchestratorDeps => ({
  acquireBrowser: async () => {
    throw new Error("unused")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
})

describe("request logging", () => {
  test("logs WAF metadata and records provider metrics on success and failure", async () => {
    const store = new MetricsStore()
    const lines: string[] = []
    const info = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)))
    const errors = spyOn(console, "error").mockImplementation((line) => lines.push(String(line)))
    const waf = {
      engine: "wafmeow" as const,
      version: "3.1.0",
      state: "incomplete" as const,
      products: ["Cloudflare"],
      incompleteProducts: ["Body provider"],
      diagnostics: [{ code: "body_truncated" as const, evidence: 0 }],
      sourceTier: 1 as const,
      durationMs: 1.25,
    }
    try {
      await runLoggedScrape(
        "native",
        { url: "https://user:private@example.com/path?secret=1" },
        deps(),
        async () => ({
          url: "https://example.com",
          html: "private-html",
          cookies: [],
          userAgent: "private-agent",
          statusCode: 200,
          tier: 1,
          sessionCached: false,
          timings: [],
          totalMs: 2,
          waf,
        }),
        "owned",
        store,
      )
      const error = new ScrapeError("blocked", [{ tier: 1, status: "blocked", durationMs: 2 }])
      error.waf = waf
      await expect(
        runLoggedScrape(
          "flaresolverr",
          { url: "https://example.com" },
          deps(),
          async () => {
            throw error
          },
          "owned-error",
          store,
        ),
      ).rejects.toBe(error)
    } finally {
      info.mockRestore()
      errors.mockRestore()
    }
    expect(
      lines.some((line) => line.includes("event=request.success") && line.includes("wafProducts=Cloudflare")),
    ).toBe(true)
    expect(lines.some((line) => line.includes("event=request.failure") && line.includes("wafDurationMs=1.25"))).toBe(
      true,
    )
    expect(lines.join("\n")).not.toMatch(/private|secret/)
    expect(lines.some((line) => line.includes("wafIncompleteProductCount=1"))).toBe(true)
    expect(lines.join("\n")).not.toContain("Body provider")
    expect(lines.some((line) => line.includes("wafDiagnostics=body_truncated"))).toBe(true)
    expect(store.snapshot().waf.providers).toEqual([{ product: "Cloudflare", requests: 2, failures: 1 }])
    store.close()
  })
  test("records scraper results without changing their response", async () => {
    const store = new MetricsStore()
    const result: ScrapeResult = {
      url: "https://example.com/final",
      html: "ok",
      cookies: [],
      userAgent: "test",
      statusCode: 200,
      tier: 1,
      sessionCached: false,
      timings: [{ tier: 1, status: "success", durationMs: 2 }],
      totalMs: 3,
    }
    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(
        await runLoggedScrape(
          "native",
          { url: "https://example.com/private?token=1" },
          deps(),
          async () => result,
          "test",
          store,
        ),
      ).toBe(result)
    } finally {
      output.mockRestore()
    }
    expect(store.snapshot().requests).toBe(1)
    expect(store.snapshot().byTier[1]).toEqual({ attempts: 1, successes: 1 })
    expect(JSON.stringify(store.snapshot())).not.toContain("private")
  })

  test.each([
    { source: "native" as const },
    { source: "proxy" as const },
    { source: "proxy" as const, proxy: "http://user:secret@proxy.example:8080" },
  ])("logs ingress and requested upstream routing separately: %j", async ({ source, proxy }) => {
    const lines: string[] = []
    const output = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)))
    const result: ScrapeResult = {
      url: "https://example.com/",
      html: "ok",
      cookies: [],
      userAgent: "test",
      statusCode: 200,
      tier: 1,
      sessionCached: false,
      timings: [{ tier: 1, status: "success", durationMs: 2 }],
      totalMs: 3,
    }
    const attempt = result.timings[0]
    if (!attempt) throw new Error("missing test timing")
    try {
      await runLoggedScrape(
        source,
        { url: "https://user:secret@example.com/page?token=secret", proxy },
        { ...deps(), defaultMaxTimeout: 120000 },
        async (_request, tracedDeps) => {
          tracedDeps.onTierAttempt?.(attempt)
          return result
        },
        "abc123",
      )
    } finally {
      output.mockRestore()
    }

    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain(`event=request.start request=abc123 source=${source}`)
    expect(lines[0]).toContain(`upstreamProxyRequested=${Boolean(proxy)}`)
    expect(lines[0]).not.toContain(" proxy=")
    expect(lines[0]).toContain("target=https://example.com/page")
    expect(lines[0]).toContain("timeoutMs=120000")
    expect(lines.join("\n")).not.toContain("secret")
    expect(lines[1]).toContain("event=tier.complete request=abc123 tier=1 status=success")
    expect(lines[2]).toContain("event=request.success request=abc123")
  })

  test("keeps exhaustive WAF incomplete-provider details at debug level for either outcome", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `
          import { ScrapeError } from "@trawl/tiers"
          import { MetricsStore } from "./metrics.ts"
          import { runLoggedScrape } from "./requestLogging.ts"
          const store = new MetricsStore()
          const waf = { engine: "wafmeow", state: "incomplete", products: [],
            incompleteProducts: ["First provider", "Last provider"], sourceTier: 1, durationMs: 1 }
          const output = { url: "https://example.com", html: "ok", cookies: [], userAgent: "test",
            statusCode: 200, tier: 1, sessionCached: false, timings: [], totalMs: 1, waf }
          try {
            await runLoggedScrape("proxy", { url: output.url }, {}, async () => output, "debug-ok", store)
            const error = new ScrapeError("challenge persisted", [])
            error.waf = waf
            await runLoggedScrape("proxy", { url: output.url }, {}, async () => { throw error },
              "debug-error", store).catch(() => {})
          } finally { store.close() }
        `,
      ],
      cwd: import.meta.dir,
      env: { ...process.env, LOG_LEVEL: "debug" },
    })
    expect(result.exitCode).toBe(0)
    const lines = result.stdout.toString().split("\n")
    for (const request of ["debug-ok", "debug-error"]) {
      expect(
        lines.some(
          (line) =>
            line.includes(`level=debug scope=scrape event=request.waf-details request=${request} source=proxy`) &&
            line.includes('wafIncompleteProducts="First provider, Last provider"'),
        ),
      ).toBe(true)
    }
    expect(result.stderr.toString()).toContain('reason="challenge persisted"')
  })

  test("a fresh browser solve resets the Tier 1 needs-js streak for the next HTTP replay", async () => {
    const target = "https://learn-cache-regression.test/page"
    const seen: ScrapeRequest[] = []
    const timings = (): TierResult[] => [
      { tier: 1, status: "needs-js", reason: "javascript-shell", durationMs: 5 },
      { tier: 2, status: "success", durationMs: 10 },
    ]
    const result = (sessionCached: boolean): ScrapeResult => ({
      url: target,
      html: "ok",
      cookies: [],
      userAgent: "test",
      statusCode: 200,
      tier: 2,
      sessionCached,
      timings: timings(),
      totalMs: 15,
    })
    const run = (outcome: ScrapeResult) =>
      runLoggedScrape(
        "native",
        { url: target },
        deps(),
        async (request) => {
          seen.push(request)
          return outcome
        },
        "learn",
        new MetricsStore(),
      )

    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      // A cold session with a successful browser solve earned a fresh clearance, so the
      // next request must try Tier 1 again instead of skipping it.
      await run(result(false))
      await run(result(true))
      await run(result(true))
      await run(result(true))
    } finally {
      output.mockRestore()
    }

    expect(seen).toHaveLength(4)
    expect(seen[0]?.skipHttp).toBeFalsy()
    // A cached-session success does not reset the streak...
    expect(seen[1]?.skipHttp).toBeFalsy()
    expect(seen[2]?.skipHttp).toBeFalsy()
    // ...so two consecutive needs-js outcomes skip Tier 1 again.
    expect(seen[3]?.skipHttp).toBe(true)
  })

  test.each([
    { maxTier: 1 },
    { skipHttp: false },
    { proxy: "http://proxy.test:8080" },
    { headers: { Authorization: "test-only" } },
    { cookies: [{ name: "session", value: "test-only" }] },
    { sessionId: "named" },
    { method: "POST" },
  ] satisfies Partial<ScrapeRequest>[])("learned HTTP hints respect request options: %j", async (options) => {
    const target = `https://${Object.keys(options)[0]}.profile-options.test/page`
    const seen: ScrapeRequest[] = []
    const run = (req: ScrapeRequest) =>
      runLoggedScrape(
        "native",
        req,
        deps(),
        async (request) => {
          seen.push(request)
          return {
            url: target,
            html: "content",
            cookies: [],
            userAgent: "test",
            statusCode: 200,
            tier: 2,
            sessionCached: true,
            totalMs: 2,
            timings: [
              { tier: 1, status: "needs-js", reason: "javascript-shell", durationMs: 1 },
              { tier: 2, status: "success", durationMs: 1 },
            ],
          }
        },
        "profile",
        new MetricsStore(),
      )
    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      await run({ url: target })
      await run({ url: target })
      await run({ url: target, ...options })
    } finally {
      output.mockRestore()
    }
    expect(seen.at(-1)?.skipHttp).toBe(options.skipHttp)
  })

  test("learned HTTP hints stay within the same URL", async () => {
    const target = "https://profile-scope.test/challenge?a=1"
    const seen: ScrapeRequest[] = []
    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      for (const url of [
        target,
        target,
        "https://profile-scope.test/article",
        "https://profile-scope.test/challenge?a=2",
      ]) {
        await runLoggedScrape(
          "native",
          { url },
          deps(),
          async (req) => {
            seen.push(req)
            return {
              url,
              html: "content",
              cookies: [],
              userAgent: "test",
              statusCode: 200,
              tier: 2,
              sessionCached: true,
              totalMs: 2,
              timings: [
                { tier: 1, status: "needs-js", reason: "javascript-shell", durationMs: 1 },
                { tier: 2, status: "success", durationMs: 1 },
              ],
            }
          },
          "scope",
          new MetricsStore(),
        )
      }
    } finally {
      output.mockRestore()
    }
    expect(seen[2]?.skipHttp).toBeUndefined()
    expect(seen[3]?.skipHttp).toBeUndefined()
  })

  test("learned hints expire and never suppress provider challenge detection", () => {
    const req = { url: "https://profile-expiry.test/" }
    const timings: TierResult[] = [{ tier: 1, status: "needs-js", reason: "javascript-shell", durationMs: 1 }]
    for (let i = 0; i < 2; i++) refreshDomainProfile(req, timings, { resultTier: 2, sessionCached: true })
    expect(applyDomainProfile(req).skipHttp).toBe(true)
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000)
    try {
      expect(applyDomainProfile(req).skipHttp).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
    for (const reason of ["cloudflare-challenge", "anubis-challenge", "datadome-interstitial"]) {
      for (let i = 0; i < 2; i++)
        refreshDomainProfile(req, [{ tier: 1, status: "needs-js", reason, durationMs: 1 }], {
          resultTier: 2,
          sessionCached: true,
        })
      expect(applyDomainProfile(req).skipHttp).toBeUndefined()
    }
  })

  test("a failed browser request clears its learned hint", async () => {
    const req = { url: "https://profile-failure.test/" }
    const timings: TierResult[] = [{ tier: 1, status: "needs-js", reason: "javascript-shell", durationMs: 1 }]
    for (let i = 0; i < 2; i++) refreshDomainProfile(req, timings, { resultTier: 2, sessionCached: true })
    expect(applyDomainProfile(req).skipHttp).toBe(true)
    const output = spyOn(console, "error").mockImplementation(() => {})
    const start = spyOn(console, "log").mockImplementation(() => {})
    try {
      await expect(
        runLoggedScrape(
          "native",
          req,
          deps(),
          async () => {
            throw new Error("Browser unavailable")
          },
          "failed",
          new MetricsStore(),
        ),
      ).rejects.toThrow("Browser unavailable")
    } finally {
      output.mockRestore()
      start.mockRestore()
    }
    expect(applyDomainProfile(req).skipHttp).toBeUndefined()
  })
})
