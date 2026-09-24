import { describe, expect, spyOn, test } from "bun:test"
import type { OrchestratorDeps } from "@trawl/tiers"
import type { ScrapeResult } from "@trawl/types"
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
  test("logs a redacted start, each tier, and a success summary", async () => {
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
        "native",
        { url: "https://user:secret@example.com/page?token=secret" },
        deps(),
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
    expect(lines[0]).toContain("event=request.start request=abc123 source=native")
    expect(lines[0]).toContain("target=https://example.com/page")
    expect(lines.join("\n")).not.toContain("secret")
    expect(lines[1]).toContain("event=tier.complete request=abc123 tier=1 status=success")
    expect(lines[2]).toContain("event=request.success request=abc123")
  })
})
