import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { waitForDataDomeResolution } from "../src/utils/datadomeWait"
import { DATADOME_CAPTCHA, DATADOME_INTERSTITIAL, DATADOME_JSON_HARD_BLOCK } from "./fixtures/datadome"

function pageFixture(options: {
  html: () => string
  cookies: () => Array<{ name: string; domain: string; value: string }>
}) {
  let gotos = 0
  const page = {
    url: () => "https://shop.example.test/item",
    content: async () => options.html(),
    context: () => ({ cookies: async () => options.cookies() }),
    waitForLoadState: async () => {},
    goto: async () => {
      gotos++
      return null
    },
  } as unknown as Page
  return { page, gotos: () => gotos }
}

describe("DataDome waiter", () => {
  test("waits for a fresh domain-matching cookie and stable wall disappearance", async () => {
    let reads = 0
    const fixture = pageFixture({
      html: () => (++reads < 3 ? DATADOME_INTERSTITIAL : "<html>real content</html>"),
      cookies: () => (reads >= 2 ? [{ name: "datadome", domain: ".example.test", value: "cleared" }] : []),
    })
    expect(
      await waitForDataDomeResolution(fixture.page, 100, "https://shop.example.test/item", {
        pollMs: 1,
        stablePolls: 2,
      }),
    ).toBe("ok")
  })

  test("ignores the cookie the block page itself issued", async () => {
    const blocked = [{ name: "datadome", domain: ".example.test", value: "from-block-page" }]
    const fixture = pageFixture({ html: () => DATADOME_INTERSTITIAL, cookies: () => blocked })
    expect(
      await waitForDataDomeResolution(fixture.page, 15, "https://shop.example.test/item", {
        pollMs: 1,
        initialCookies: new Set([".example.test:from-block-page"]),
      }),
    ).toBe("timeout")
  })

  test("renavigates the original URL when the Device Check redirect never fires", async () => {
    let cleared = false
    let cookieReads = 0
    const fixture = pageFixture({
      html: () => (cleared ? "<html>real content</html>" : DATADOME_INTERSTITIAL),
      cookies: () => (++cookieReads > 1 ? [{ name: "datadome", domain: "shop.example.test", value: "cleared" }] : []),
    })
    const originalGoto = fixture.page.goto.bind(fixture.page)
    fixture.page.goto = (async (...args: Parameters<Page["goto"]>) => {
      cleared = true
      return originalGoto(...args)
    }) as Page["goto"]
    expect(
      await waitForDataDomeResolution(fixture.page, 100, "https://shop.example.test/item", {
        pollMs: 1,
        stablePolls: 1,
        redirectGraceMs: 0,
      }),
    ).toBe("ok")
    expect(fixture.gotos()).toBe(1)
  })

  test("reports a wall that survives the cookie as an IP problem", async () => {
    let cookieReads = 0
    const fixture = pageFixture({
      html: () => DATADOME_INTERSTITIAL,
      cookies: () => (++cookieReads > 1 ? [{ name: "datadome", domain: "example.test", value: "cleared" }] : []),
    })
    expect(
      await waitForDataDomeResolution(fixture.page, 15, "https://example.test/", { pollMs: 1, redirectGraceMs: 0 }),
    ).toBe("ip-blocked")
  })

  test("surfaces the slider instead of waiting it out", async () => {
    const fixture = pageFixture({ html: () => DATADOME_CAPTCHA, cookies: () => [] })
    expect(await waitForDataDomeResolution(fixture.page, 50, "https://example.test/", { pollMs: 1 })).toBe(
      "captcha-required",
    )
  })

  test("treats the hard block as an IP problem, not a challenge", async () => {
    const fixture = pageFixture({ html: () => DATADOME_JSON_HARD_BLOCK, cookies: () => [] })
    expect(await waitForDataDomeResolution(fixture.page, 50, "https://example.test/", { pollMs: 1 })).toBe("ip-blocked")
  })
})
