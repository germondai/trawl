import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"

const makeHandle = () => {
  let contexts = 0
  let closes = 0
  const context = {
    addInitScript: async () => {},
    newPage: async () => {
      throw new Error("page creation failed")
    },
    close: async () => {
      closes++
    },
  }
  const handle = {
    id: 0,
    lease: 1,
    headful: false,
    context: {},
    browser: { newContext: async () => context },
    fingerprint: { userAgent: "test", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    noteTemporaryContext: () => {
      contexts++
    },
  } satisfies BrowserHandle
  return { handle, counts: () => ({ contexts, closes }) }
}

describe("temporary context cleanup", () => {
  test("Tier 3 counts and closes a context when page creation fails", async () => {
    const { handle, counts } = makeHandle()
    const result = await runTier3("https://example.com", handle, 1_000)
    expect(result.status).toBe("error")
    expect(counts()).toEqual({ contexts: 1, closes: 1 })
  })

  test("Tier 4 counts and closes a context when page creation fails", async () => {
    const { handle, counts } = makeHandle()
    const result = await runTier4("https://example.com", handle, 1_000, "http://proxy.example:8080")
    expect(result.status).toBe("error")
    expect(counts()).toEqual({ contexts: 1, closes: 1 })
  })
})
