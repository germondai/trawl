import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"
import { followMetaRefresh, MAX_REFRESH_HOPS, metaRefreshTarget } from "../src/utils/metaRefresh"

const FORWARDER = "https://short.example/abc"
const DESTINATION = "https://destination.example/landing"
// A forwarding document is often nothing but the refresh: under the tiers' 100-character
// empty-content floor, so without following it the scrape fails as empty.
const FORWARD_SHELL = `<meta http-equiv="refresh" content="0; url=${DESTINATION}">`
const DESTINATION_PAGE = `<html><head><title>Destination</title></head><body>${"real content ".repeat(20)}</body></html>`

const fingerprint = { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" }

// A page over a map of url -> document. `browserFires` says whether the stub browser acts
// on a meta refresh by itself; when it does not, only an explicit goto moves the page.
const makeSite = (documents: Record<string, string>, options: { browserFires?: boolean } = {}) => {
  let current = "about:blank"
  const gotos: string[] = []
  const page = {
    url: () => current,
    title: async () => "",
    content: async () => documents[current] ?? "",
    goto: async (url: string) => {
      gotos.push(url)
      current = url
    },
    waitForURL: async () => {
      const refresh = metaRefreshTarget(documents[current] ?? "", current)
      if (options.browserFires && refresh) {
        current = refresh.url
        return
      }
      throw new Error("Timeout exceeded while waiting for the url to change")
    },
    on: () => {},
    mainFrame: () => ({}),
    frames: () => [],
    context: () => ({ cookies: async () => [] }),
    evaluate: async () => "test-agent",
    setExtraHTTPHeaders: async () => {},
    route: async () => {},
    waitForLoadState: async () => {},
    close: async () => {},
    screenshot: async () => Buffer.from(""),
  }
  return { page, gotos, landed: () => current }
}

const freshHandle = (page: unknown): BrowserHandle =>
  ({
    id: 2,
    lease: 1,
    context: {},
    browser: {
      newContext: async () => ({
        newPage: async () => page,
        addInitScript: async () => {},
        cookies: async () => [],
        close: async () => {},
      }),
    },
    fingerprint,
  }) satisfies BrowserHandle

const at = (site: ReturnType<typeof makeSite>, url: string) => site.page.goto(url).then(() => site.gotos.splice(0))

describe("metaRefreshTarget", () => {
  test("reads an immediate refresh to another url", () => {
    expect(FORWARD_SHELL.length).toBeLessThan(100)
    expect(metaRefreshTarget(FORWARD_SHELL, FORWARDER)).toEqual({ delayMs: 0, url: DESTINATION })
  })

  test("accepts any attribute order, quoting and case, and resolves a relative url", () => {
    const html = `<META CONTENT='2.5;URL=/next?a=1' HTTP-EQUIV='Refresh'>`
    expect(metaRefreshTarget(html, "https://a.example/x/y")).toEqual({
      delayMs: 2500,
      url: "https://a.example/next?a=1",
    })
  })

  test("ignores a refresh that names no url, which only reloads the page", () => {
    expect(metaRefreshTarget(`<meta http-equiv="refresh" content="360">`, DESTINATION)).toBeUndefined()
  })

  test("ignores a refresh to a non-http target", () => {
    expect(
      metaRefreshTarget(`<meta http-equiv="refresh" content="0; url=javascript:alert(1)">`, FORWARDER),
    ).toBeUndefined()
  })

  test("finds nothing on a page without one", () => {
    expect(metaRefreshTarget(DESTINATION_PAGE, DESTINATION)).toBeUndefined()
  })
})

describe("followMetaRefresh", () => {
  test("waits for the browser to fire the refresh and reports where it landed", async () => {
    const site = makeSite({ [FORWARDER]: FORWARD_SHELL, [DESTINATION]: DESTINATION_PAGE }, { browserFires: true })
    await at(site, FORWARDER)

    expect(await followMetaRefresh(site.page as never, 10_000)).toBe(DESTINATION)
    expect(site.gotos).toEqual([])
  })

  test("navigates itself when the browser does not fire it", async () => {
    const site = makeSite({ [FORWARDER]: FORWARD_SHELL, [DESTINATION]: DESTINATION_PAGE })
    await at(site, FORWARDER)

    expect(await followMetaRefresh(site.page as never, 10_000)).toBe(DESTINATION)
    expect(site.gotos).toEqual([DESTINATION])
  })

  test("stops after one try when its own navigation does not move the page", async () => {
    const site = makeSite({ [FORWARDER]: FORWARD_SHELL })
    await at(site, FORWARDER)
    const gotos: string[] = []
    site.page.goto = async (url: string) => {
      gotos.push(url)
      throw new Error("Timeout 30000ms exceeded")
    }

    expect(await followMetaRefresh(site.page as never, 10_000)).toBeUndefined()
    expect(gotos).toEqual([DESTINATION])
    expect(site.landed()).toBe(FORWARDER)
  })

  test("leaves a long-delay refresh alone", async () => {
    const site = makeSite({ [FORWARDER]: `<meta http-equiv="refresh" content="30; url=${DESTINATION}">` })
    await at(site, FORWARDER)

    expect(await followMetaRefresh(site.page as never, 10_000)).toBeUndefined()
    expect(site.landed()).toBe(FORWARDER)
  })

  test("does not loop on a refresh to itself", async () => {
    const site = makeSite({ [FORWARDER]: `<meta http-equiv="refresh" content="0; url=${FORWARDER}">` })
    await at(site, FORWARDER)

    expect(await followMetaRefresh(site.page as never, 10_000)).toBeUndefined()
    expect(site.gotos).toEqual([])
  })

  test("stops a chain after MAX_REFRESH_HOPS", async () => {
    const hop = (n: number) => `https://hop${n}.example/`
    const documents: Record<string, string> = {}
    for (let n = 0; n < 10; n++) documents[hop(n)] = `<meta http-equiv="refresh" content="0; url=${hop(n + 1)}">`
    const site = makeSite(documents)
    await at(site, hop(0))

    expect(await followMetaRefresh(site.page as never, 10_000)).toBe(hop(MAX_REFRESH_HOPS))
    expect(site.gotos).toHaveLength(MAX_REFRESH_HOPS)
  })
})

describe("browser tiers", () => {
  const PROXY = "http://proxy.example:8080"
  const documents = { [FORWARDER]: FORWARD_SHELL, [DESTINATION]: DESTINATION_PAGE }

  test("a forwarding shell still fails as empty content by default", async () => {
    const result = await runTier4(FORWARDER, freshHandle(makeSite(documents).page), 4_000, PROXY)

    expect(result.status).toBe("error")
    expect(result.reason).toBe("page returned empty content")
  })

  test("followRefresh scrapes the destination on Tier 4", async () => {
    const site = makeSite(documents)
    const result = await runTier4(
      FORWARDER,
      freshHandle(site.page),
      4_000,
      PROXY,
      {},
      "GET",
      "",
      undefined,
      false,
      {},
      false,
      true,
    )

    expect(result.status).toBe("success")
    expect(result.effectiveUrl).toBe(DESTINATION)
    expect(result.html).toContain("real content")
    expect(site.gotos).toEqual([FORWARDER, DESTINATION])
  })

  test("followRefresh scrapes the destination on Tier 3 too", async () => {
    const site = makeSite(documents)
    const result = await runTier3(
      FORWARDER,
      freshHandle(site.page),
      4_000,
      PROXY,
      {},
      "GET",
      "",
      undefined,
      false,
      {},
      false,
      true,
    )

    expect(result.status).toBe("success")
    expect(result.effectiveUrl).toBe(DESTINATION)
  })
})

describe("orchestrator", () => {
  const depsFor = (page: unknown): OrchestratorDeps => ({
    acquireBrowser: async () => freshHandle(page),
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  })
  const request = { url: FORWARDER, skipHttp: true, maxTier: 3 as const, maxTimeout: 4_000 }

  test("passes followMetaRefresh through to the tiers", async () => {
    const site = makeSite({ [FORWARDER]: FORWARD_SHELL, [DESTINATION]: DESTINATION_PAGE })
    const result = await scrape({ ...request, followMetaRefresh: true }, depsFor(site.page))

    expect(result.url).toBe(DESTINATION)
    expect(result.html).toContain("real content")
  })

  test("still fails the shell as empty content when it is not set", async () => {
    const site = makeSite({ [FORWARDER]: FORWARD_SHELL, [DESTINATION]: DESTINATION_PAGE })
    const error = await scrape(request, depsFor(site.page)).then(
      () => undefined,
      (e) => e,
    )

    expect(error?.timings?.map((t: { reason?: string }) => t.reason)).toEqual(["page returned empty content"])
  })
})
