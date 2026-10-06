import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import { waitForAnubisResolution } from "../src/utils/anubisWait"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { ANUBIS_CHALLENGE } from "./fixtures/anubis"

const ordinary = `<html><body>${"Upstream content. ".repeat(20)}</body></html>`
const pageWith = (content: () => Promise<string>) => ({ content }) as Page

describe("Anubis browser wait", () => {
  test("waits for two readable destination samples after the challenge clears", async () => {
    const samples = [ANUBIS_CHALLENGE, ordinary, "", ordinary, ordinary]
    let reads = 0
    const result = await waitForAnubisResolution(
      pageWith(async () => samples[reads++] ?? ordinary),
      1000,
      undefined,
      { pollMs: 1 },
    )
    expect(result).toBe("ok")
    expect(reads).toBe(5)
  })
  test("tolerates a DOM read interrupted by navigation", async () => {
    let reads = 0
    const result = await waitForAnubisResolution(
      pageWith(async () => {
        if (++reads === 1) throw new Error("Execution context destroyed during navigation")
        return ordinary
      }),
      1000,
      undefined,
      { pollMs: 1 },
    )
    expect(result).toBe("ok")
    expect(reads).toBe(3)
  })
  test.each([
    ANUBIS_CHALLENGE,
    "",
    '<html><head><title data-l10n-id="neterror-page-title">Error</title></head><body>Network error</body></html>',
  ])("never treats a challenge, empty document or browser error as success %#", async (html) => {
    expect(
      await waitForAnubisResolution(
        pageWith(async () => html),
        20,
        undefined,
        { pollMs: 1 },
      ),
    ).toBe("timeout")
  })
  test("bounds an unresponsive DOM read by the supplied budget", async () => {
    const started = Date.now()
    expect(
      await waitForAnubisResolution(
        pageWith(() => new Promise(() => {})),
        30,
      ),
    ).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(500)
  })
  test("does not read the DOM after the budget is exhausted", async () => {
    let reads = 0
    expect(
      await waitForAnubisResolution(
        pageWith(async () => {
          reads++
          return ordinary
        }),
        0,
      ),
    ).toBe("timeout")
    expect(reads).toBe(0)
  })
  test("rejects an error document after verification", async () => {
    expect(
      await waitForAnubisResolution(
        pageWith(async () => ordinary),
        100,
        undefined,
        {
          pollMs: 1,
          response: () => ({ status: 503 }),
        },
      ),
    ).toBe("blocked")
  })
  test("allows an error status on the challenge before a successful destination", async () => {
    let reads = 0
    expect(
      await waitForAnubisResolution(
        pageWith(async () => (++reads === 1 ? ANUBIS_CHALLENGE : ordinary)),
        100,
        undefined,
        {
          pollMs: 1,
          response: () => ({ status: reads === 1 ? 429 : 200 }),
        },
      ),
    ).toBe("ok")
  })
  test("rejects verification endpoint content even at HTTP 200", async () => {
    const page = {
      content: async () => ordinary,
      url: () => "https://fixture.test/nested/.within.website/x/cmd/anubis/api/pass-challenge",
    } as Page
    expect(await waitForAnubisResolution(page, 100, undefined, { pollMs: 1 })).toBe("blocked")
  })
  test("stops repeated challenge reissues", async () => {
    let reads = 0
    expect(
      await waitForAnubisResolution(
        pageWith(async () => ANUBIS_CHALLENGE.replace("fixture-challenge", String(++reads))),
        100,
        undefined,
        { pollMs: 1 },
      ),
    ).toBe("blocked")
    expect(reads).toBe(3)
  })
  test.each([
    "<html><head><title>Article</title></head><body><script>loadArticle()</script></body></html>",
    '<html><body><!--<img src="example.png">--></body></html>',
    '<html><body><template><img src="example.png"></template><noscript>Enable JavaScript</noscript></body></html>',
  ])("does not accept an empty or inert HTML shell %#", async (html) => {
    expect(
      await waitForAnubisResolution(
        pageWith(async () => html),
        20,
        undefined,
        { pollMs: 1 },
      ),
    ).toBe("timeout")
  })
  test("does not accept a destination while its document is loading", async () => {
    const page = { content: async () => ordinary, evaluate: async () => "loading" } as unknown as Page
    expect(await waitForAnubisResolution(page, 20, undefined, { pollMs: 1 })).toBe("timeout")
  })
  test("bounds a stalled readyState read", async () => {
    const page = { content: async () => ordinary, evaluate: () => new Promise(() => {}) } as unknown as Page
    const start = Date.now()
    expect(await waitForAnubisResolution(page, 20)).toBe("timeout")
    expect(Date.now() - start).toBeLessThan(500)
  })
  test("requires two samples at the same destination URL", async () => {
    let reads = 0
    const page = {
      content: async () => {
        reads++
        return ordinary
      },
      url: () => (reads === 1 ? "https://fixture.test/a" : "https://fixture.test/b"),
    } as Page
    expect(await waitForAnubisResolution(page, 100, undefined, { pollMs: 1 })).toBe("ok")
    expect(reads).toBe(3)
  })

  test("stops when the browser page closes", async () => {
    const page = { content: async () => ANUBIS_CHALLENGE, isClosed: () => true } as Page
    const start = Date.now()
    expect(await waitForAnubisResolution(page, 10000)).toBe("browser-closed")
    expect(Date.now() - start).toBeLessThan(100)
  })
  test("routes Anubis to its waiter instead of attempting Cloudflare controls", async () => {
    const calls: string[] = []
    const waiter = (name: string) => async () => {
      calls.push(name)
      return "ok" as const
    }
    const result = await routeChallengeWait({} as Page, ANUBIS_CHALLENGE, {}, 1000, "https://fixture.test/", {
      anubis: waiter("anubis"),
      cloudflare: waiter("cloudflare"),
      imperva: waiter("imperva"),
      akamai: waiter("akamai"),
      ddosGuard: waiter("ddos-guard"),
      awsWaf: waiter("aws-waf"),
      dataDome: waiter("datadome"),
    })
    expect(result).toEqual({ challengeType: "anubis", resolution: "ok" })
    expect(calls).toEqual(["anubis"])
  })
})
