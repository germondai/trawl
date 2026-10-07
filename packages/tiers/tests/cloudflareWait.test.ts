import { expect, test } from "bun:test"
import type { Page } from "patchright"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { waitForChallengeResolution } from "../src/utils/challengeWait"

const wall =
  '<html><head><title>Just a moment...</title></head><body id="challenge-form">Checking your browser</body></html>'
const destination = "<html><head><title>Article</title></head><body><article>Requested content</article></body></html>"

function pageFixture() {
  return {
    title: async () => "Just a moment...",
    content: async () => wall,
    url: () => "https://example.test/article",
    frames: () => [],
    context: () => ({ cookies: async () => [{ name: "cf_clearance", domain: "example.test" }] }),
    keyboard: { press: async () => {} },
    waitForLoadState: async () => {},
    goto: async () => {},
  }
}

test("Cloudflare routing reads the latest main-document headers after navigation", async () => {
  const page = pageFixture()
  let navigated = false
  page.title = async () => {
    navigated = true
    return "Article"
  }
  page.content = async () => destination
  const headers = (): Record<string, string> => (navigated ? {} : { "cf-mitigated": "challenge" })
  const result = await routeChallengeWait(
    page as unknown as Page,
    wall,
    headers(),
    1500,
    page.url(),
    undefined,
    403,
    undefined,
    headers,
  )
  expect(result).toEqual({ challengeType: "cloudflare-interstitial", resolution: "ok" })
})

test("clearance and a completed goto do not declare a persistent wall solved", async () => {
  const page = pageFixture()
  let navigations = 0
  page.goto = async () => {
    navigations++
  }
  const result = await waitForChallengeResolution(page as unknown as Page, 6500, page.url())
  expect(navigations).toBe(1)
  expect(result).toBe("timeout")
}, 8000)

test("manual clearance recovery confirms the destination without waiting for network idle", async () => {
  const page = pageFixture()
  let recovered = false
  const loadStates: string[] = []
  page.goto = async () => {
    recovered = true
  }
  page.title = async () => (recovered ? "Article" : "Just a moment...")
  page.content = async () => (recovered ? destination : wall)
  page.waitForLoadState = async (state?: string) => {
    loadStates.push(state ?? "load")
  }
  const result = await waitForChallengeResolution(page as unknown as Page, 7500, page.url())
  expect(result).toBe("ok")
  expect(loadStates).not.toContain("networkidle")
}, 9000)
