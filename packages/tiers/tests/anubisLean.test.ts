import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { waitForAnubisResolution } from "../src/utils/anubisWait"
import { hasAnubisChallenge, isCloudflarePage } from "../src/utils/detect"
import { ANUBIS_CHALLENGE } from "./fixtures/anubis"

describe("lean Anubis handling", () => {
  test("a version marker or asset link alone is ordinary content", () => {
    expect(
      hasAnubisChallenge('<script id="anubis_version" type="application/json">"1.27"</script><p>Documentation</p>'),
    ).toBe(false)
    expect(hasAnubisChallenge('<a href="/.within.website/x/cmd/anubis/static/js/main.mjs">Source</a>')).toBe(false)
  })

  test("an Anubis checking title does not route to Cloudflare", () => {
    expect(
      isCloudflarePage(ANUBIS_CHALLENGE.replace(/<title>[^<]*<\/title>/, "<title>Checking your browser</title>"), {}),
    ).toBe(false)
  })

  test("a stalled browser read cannot exceed the wait budget", async () => {
    const never = () => new Promise<never>(() => {})
    const page = { content: never, evaluate: never, isClosed: () => false } as unknown as Page
    const result = await Promise.race([
      waitForAnubisResolution(page, 20),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
    ])
    expect(result).toBe("timeout")
  })

  test("waiting samples the browser DOM without transferring full HTML", async () => {
    let reads = 0
    const page = {
      content: async () => {
        reads++
        return ANUBIS_CHALLENGE
      },
      evaluate: async () => ({ ready: true, content: true }),
      isClosed: () => false,
      url: () => "https://example.test/article",
    } as unknown as Page
    expect(await waitForAnubisResolution(page, 1000)).toBe("ok")
    expect(reads).toBe(0)
  })
  test.each([
    ["denial", { state: "blocked", ready: true, content: true }, "https://example.test/", "blocked"],
    ["empty shell", { ready: true, content: false }, "https://example.test/", "timeout"],
    ["loading page", { ready: false, content: true }, "https://example.test/", "timeout"],
    ["closed page", { ready: true, content: true }, "https://example.test/", "browser-closed"],
  ] as const)("rejects %s", async (name, sample, url, expected) => {
    const page = {
      evaluate: async () => sample,
      isClosed: () => name === "closed page",
      url: () => url,
    } as unknown as Page
    expect(await waitForAnubisResolution(page, 30)).toEqual(expected)
  })

  test("allows a transient verification redirect but rejects a stuck endpoint", async () => {
    const endpoint = "https://example.test/.within.website/x/cmd/anubis/api/pass-challenge"
    let reads = 0
    const page = {
      evaluate: async () => ({ ready: true, content: true }),
      isClosed: () => false,
      url: () => (++reads === 1 ? endpoint : "https://example.test/article"),
    } as unknown as Page
    expect(await waitForAnubisResolution(page, 1000)).toBe("ok")
    page.url = () => endpoint
    expect(await waitForAnubisResolution(page, 30)).toBe("timeout")
  })
  test("lets a delayed verification redirect finish within the request budget", async () => {
    let reads = 0
    const page = {
      evaluate: async () => ({ ready: true, content: true }),
      isClosed: () => false,
      url: () =>
        ++reads <= 3
          ? "https://example.test/.within.website/x/cmd/anubis/api/pass-challenge"
          : "https://example.test/article",
    } as unknown as Page
    expect(await waitForAnubisResolution(page, 2000)).toBe("ok")
  })
})
