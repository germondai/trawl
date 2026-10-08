import { afterAll, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { parseHTML } from "linkedom"
import type { Page } from "patchright"
import { buildScrapeRequestFromFlareSolverr } from "../../../apps/api/src/adapters/flaresolverr"
import { scrape } from "../src/orchestrator"
import { runTier2 } from "../src/tiers/2"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"
import { followMetaRefresh, metaRefreshTarget } from "../src/utils/metaRefresh"

const START = "https://source.example/start"
const FINAL = "https://destination.example/final"
const SHELL = `<meta http-equiv="refresh" content="0; url=${FINAL}">`
const CONTENT = `<html><body>${"Destination content ".repeat(20)}</body></html>`

function makeSite(documents: Record<string, string>, automatic = false) {
  let current = START
  let closed = 0
  const gotos: string[] = []
  const page = {
    url: () => current,
    content: async () => documents[current] ?? CONTENT,
    evaluate: async (fn: () => unknown): Promise<unknown> => {
      if (!fn.toString().includes("querySelectorAll")) return "test-agent"
      const { document } = parseHTML(documents[current] ?? CONTENT)
      return {
        url: current,
        baseUrl: new URL(document.querySelector("base[href]")?.getAttribute("href") ?? current, current).href,
        contents: Array.from(document.querySelectorAll("meta[http-equiv]"))
          .filter((meta) => meta.getAttribute("http-equiv")?.toLowerCase() === "refresh")
          .map((meta) => meta.getAttribute("content") ?? ""),
      }
    },
    waitForURL: async () => {
      if (!automatic) throw new Error("Timeout")
      const refresh = await metaRefreshTarget(documents[current] ?? CONTENT, current)
      if (refresh) current = refresh.url
    },
    goto: async (url: string) => {
      gotos.push(url)
      current = url
    },
    title: async () => "Destination",
    frames: () => [],
    on: () => {},
    mainFrame: () => ({}),
    context: () => ({ cookies: async () => [] }),
    setExtraHTTPHeaders: async () => {},
    route: async () => {},
    waitForLoadState: async () => {},
    close: async () => {
      closed++
    },
  }
  const context = {
    newPage: async () => page,
    addCookies: async () => {},
    addInitScript: async () => {},
    cookies: async () => [],
    close: async () => {
      closed++
    },
  }
  const handle: BrowserHandle = {
    id: 1,
    lease: 1,
    headful: false,
    context,
    browser: { newContext: async () => context },
    fingerprint: { userAgent: "test-agent", platform: "Linux x86_64" as const, locale: "en-US", timezone: "UTC" },
  }
  return { page, handle, gotos, closed: () => closed }
}

const asPage = (site: ReturnType<typeof makeSite>) => site.page as unknown as Page

describe("meta refresh parsing", () => {
  test("decodes entities, honors base href and ignores commented or scripted markup", async () => {
    const html = `<!-- ${SHELL} --><script>const example = '${SHELL}'</script>
      <base href="https://destination.example/root/"><META CONTENT='2.5;URL=next?a=1&amp;b=2' HTTP-EQUIV='Refresh'>`
    expect(await metaRefreshTarget(html, START)).toEqual({
      delayMs: 2500,
      url: "https://destination.example/root/next?a=1&b=2",
    })
    expect(await metaRefreshTarget(`<!-- ${SHELL} -->`, START)).toBeUndefined()
  })

  test("accepts alternate attribute order, quotes, comma and relative targets", async () => {
    expect(await metaRefreshTarget(`<meta content="0, '/next'" http-equiv=refresh>`, START)).toEqual({
      delayMs: 0,
      url: "https://source.example/next",
    })
    expect(
      await metaRefreshTarget(`<base href="http://["><meta http-equiv=refresh content="0; /next">`, START),
    ).toEqual({ delayMs: 0, url: "https://source.example/next" })
  })

  test("ignores inert template markup and uses case-insensitive base attributes", async () => {
    expect(await metaRefreshTarget(`<template>${SHELL}</template><noscript>${SHELL}</noscript>`, START)).toBeUndefined()
    expect(
      await metaRefreshTarget(
        `<template><base href="https://wrong.example/"></template><BASE HREF="https://destination.example/root/"><meta http-equiv=refresh content="10; next">`,
        START,
      ),
    ).toEqual({ delayMs: 10_000, url: "https://destination.example/root/next" })
  })

  test("leaves reloads, long delays, invalid and non-HTTP targets alone", async () => {
    for (const content of [
      "360",
      "0",
      "0; url=",
      "0; url=''",
      "11; /next",
      "0; javascript:alert(1)",
      "0; data:text/html,x",
      "0; http://[",
      `0; ${START}`,
    ]) {
      expect(await metaRefreshTarget(`<meta http-equiv="refresh" content="${content}">`, START)).toBeUndefined()
    }
  })
})

describe("bounded browser following", () => {
  test("follows automatic redirects without a duplicate goto", async () => {
    const site = makeSite({ [START]: SHELL }, true)
    expect(await followMetaRefresh(asPage(site), 1000)).toEqual({ status: "ok", url: FINAL })
    expect(site.gotos).toEqual([])
  })

  test("retries a destroyed navigation context but preserves other evaluation errors", async () => {
    const site = makeSite({ [START]: CONTENT })
    const evaluate = site.page.evaluate
    let reads = 0
    site.page.evaluate = async (fn) => {
      if (++reads === 1)
        throw new Error("evaluate: Execution context was destroyed, most likely because of a navigation")
      return evaluate(fn)
    }
    expect(await followMetaRefresh(asPage(site), 1000)).toEqual({ status: "ok", url: START })
    expect(reads).toBe(2)
    site.page.evaluate = async () => {
      throw new Error("Target page, context or browser has been closed")
    }
    expect(await followMetaRefresh(asPage(site), 1000)).toEqual({
      status: "error",
      reason: "meta-refresh-navigation-failed",
    })
  })

  test("repeated context destruction stays within the request budget", async () => {
    const site = makeSite({ [START]: CONTENT })
    site.page.evaluate = async () => {
      throw new Error("Execution context was destroyed")
    }
    expect(await followMetaRefresh(asPage(site), 40)).toEqual({ status: "timeout", reason: "meta-refresh-timeout" })
    expect(site.gotos).toHaveLength(0)
  })

  test("uses the current URL if the browser already landed", async () => {
    const site = makeSite({})
    await site.page.goto(FINAL)
    expect(await followMetaRefresh(asPage(site), 1000)).toEqual({ status: "ok", url: FINAL })
  })

  test("falls back to navigation in the same page and validates its target", async () => {
    const site = makeSite({ [START]: SHELL })
    const checked: string[] = []
    expect(
      await followMetaRefresh(asPage(site), 1000, async (url) => {
        checked.push(url)
      }),
    ).toEqual({ status: "ok", url: FINAL })
    expect(checked).toEqual([FINAL])
    expect(site.gotos).toEqual([FINAL])
  })

  test("rejects forbidden destinations before waiting or navigating", async () => {
    const site = makeSite({ [START]: SHELL })
    let waited = false
    site.page.waitForURL = async () => {
      waited = true
    }
    const result = await followMetaRefresh(asPage(site), 1000, async () => {
      throw new Error("blocked")
    })
    expect(result.status).toBe("error")
    expect(waited).toBe(false)
    expect(site.gotos).toEqual([])
  })

  test("starts no navigation after the wait consumes the budget", async () => {
    const site = makeSite({ [START]: SHELL })
    site.page.waitForURL = async () => {
      await Bun.sleep(20)
      throw new Error("Timeout")
    }
    expect(await followMetaRefresh(asPage(site), 10)).toEqual({ status: "timeout", reason: "meta-refresh-timeout" })
    expect(site.gotos).toEqual([])
    expect((await followMetaRefresh(asPage(site), 0)).status).toBe("timeout")
  })

  test("bounds a stalled DOM read or outbound validator by the remaining budget", async () => {
    const site = makeSite({ [START]: SHELL })
    const originalEvaluate = site.page.evaluate
    site.page.evaluate = () => new Promise(() => {})
    expect((await followMetaRefresh(asPage(site), 10)).status).toBe("timeout")
    site.page.evaluate = originalEvaluate
    expect((await followMetaRefresh(asPage(site), 10, () => new Promise(() => {}))).status).toBe("timeout")
    expect(site.gotos).toEqual([])
  })

  test("reports navigation errors instead of returning forwarding content", async () => {
    const site = makeSite({ [START]: SHELL })
    site.page.goto = async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED")
    }
    expect(await followMetaRefresh(asPage(site), 1000)).toEqual({
      status: "error",
      reason: "meta-refresh-navigation-failed",
    })
  })

  test("accepts a completed competing navigation after an interrupted fallback", async () => {
    for (const message of ["goto: NS_BINDING_ABORTED", "goto: Navigation is interrupted by another navigation"]) {
      const site = makeSite({ [START]: SHELL, [FINAL]: CONTENT })
      const goto = site.page.goto
      let waits = 0
      site.page.waitForURL = async () => {
        if (++waits === 1) throw new Error("Timeout")
        if (waits === 2) throw new Error("waitForURL: NS_BINDING_ABORTED; maybe frame was detached?")
      }
      site.page.goto = async (url) => {
        await goto(url)
        throw new Error(message)
      }
      expect(await followMetaRefresh(asPage(site), 1000)).toEqual({ status: "ok", url: FINAL })
      expect(waits).toBe(3)
    }
  })

  test("repeated navigation interruptions cannot extend the destination wait budget", async () => {
    const site = makeSite({ [START]: SHELL, [FINAL]: CONTENT })
    let waits = 0
    site.page.waitForURL = async () => {
      throw new Error(++waits === 1 ? "Timeout" : "NS_BINDING_ABORTED")
    }
    const goto = site.page.goto
    site.page.goto = async (url) => {
      await goto(url)
      throw new Error("NS_BINDING_ABORTED")
    }
    expect(await followMetaRefresh(asPage(site), 40)).toEqual({ status: "timeout", reason: "meta-refresh-timeout" })
    expect(site.gotos).toHaveLength(1)
  })

  test("rejects browser network and certificate error documents", async () => {
    for (const documentUrl of ["about:neterror?e=connectionFailure", "about:certerror?e=nssBadCert"]) {
      const site = makeSite({ [START]: CONTENT })
      const evaluate = site.page.evaluate
      site.page.evaluate = async (fn) => ({ ...((await evaluate(fn)) as object), documentUrl })
      expect(await followMetaRefresh(asPage(site), 1000)).toEqual({
        status: "error",
        reason: "meta-refresh-navigation-failed",
      })
    }
  })

  test("does not claim success when goto returns without changing the page", async () => {
    const site = makeSite({ [START]: SHELL })
    site.page.goto = async () => {}
    expect(await followMetaRefresh(asPage(site), 1000)).toEqual({
      status: "error",
      reason: "meta-refresh-navigation-failed",
    })
  })

  test("detects loops and caps chains at three followed hops", async () => {
    const loop = makeSite({ [START]: SHELL, [FINAL]: `<meta http-equiv=refresh content="0; ${START}">` })
    expect(await followMetaRefresh(asPage(loop), 1000)).toEqual({ status: "error", reason: "meta-refresh-loop" })
    const documents: Record<string, string> = {}
    for (let n = 0; n < 5; n++) {
      documents[n === 0 ? START : `https://hop.example/${n}`] =
        `<meta http-equiv=refresh content="0; https://hop.example/${n + 1}">`
    }
    const chain = makeSite(documents)
    expect(await followMetaRefresh(asPage(chain), 1000)).toEqual({ status: "error", reason: "meta-refresh-hop-limit" })
    expect(chain.gotos).toHaveLength(3)
  })
})

const session = { cookies: [], userAgent: "test-agent", savedAt: 1 }
describe("browser tier integration", () => {
  for (const tier of [2, 3, 4] as const) {
    test(`Tier ${tier} rejects failed refreshes and still closes its page/context`, async () => {
      const site = makeSite({ [START]: SHELL + CONTENT })
      site.page.goto = async (target) => {
        if (target === FINAL) throw new Error("fixture network failure")
      }
      const capture = { followMetaRefresh: true }
      const result =
        tier === 2
          ? await runTier2(
              START,
              site.handle,
              session,
              4000,
              undefined,
              undefined,
              undefined,
              undefined,
              false,
              capture,
            )
          : tier === 3
            ? await runTier3(
                START,
                site.handle,
                4000,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                capture,
              )
            : await runTier4(
                START,
                site.handle,
                4000,
                "http://proxy.example:8080",
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                capture,
              )
      expect(result.status).toBe("error")
      expect(result.reason).toBe("meta-refresh-navigation-failed")
      expect(site.closed()).toBe(1)
    })
    test(`Tier ${tier} follows before reading destination content and closes its page/context`, async () => {
      const site = makeSite({ [START]: SHELL })
      const capture = { followMetaRefresh: true }
      const result =
        tier === 2
          ? await runTier2(
              START,
              site.handle,
              session,
              4000,
              undefined,
              undefined,
              undefined,
              undefined,
              false,
              capture,
            )
          : tier === 3
            ? await runTier3(
                START,
                site.handle,
                4000,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                capture,
              )
            : await runTier4(
                START,
                site.handle,
                4000,
                "http://proxy.example:8080",
                undefined,
                undefined,
                undefined,
                undefined,
                false,
                capture,
              )
      expect(result.status).toBe("success")
      expect(result.effectiveUrl).toBe(FINAL)
      expect(result.html).toContain("Destination content")
      expect(site.closed()).toBe(1)
    })
  }
})

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    const shell = `<meta http-equiv=refresh content="0; /final">`
    return new Response(url.pathname === "/start" ? shell : CONTENT, {
      headers: { "Content-Type": "text/html" },
    })
  },
})
afterAll(() => server.stop(true))
const start = `http://127.0.0.1:${server.port}/start`

describe("HTTP tier escalation", () => {
  const deps = {
    acquireBrowser: async (): Promise<BrowserHandle> => {
      throw new Error("browser-needed")
    },
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }

  test("ordinary requests and /v1 keep their original behavior", async () => {
    expect((await scrape({ url: start }, deps)).tier).toBe(1)
    const request = buildScrapeRequestFromFlareSolverr({ cmd: "request.get", url: start })
    expect(request.followMetaRefresh).toBeUndefined()
    expect((await scrape(request, deps)).tier).toBe(1)
    expect((await scrape({ url: start.replace("/start", "/final"), followMetaRefresh: true }, deps)).tier).toBe(1)
  })

  test("opted-in forwarders escalate instead of returning successful HTTP content", async () => {
    await expect(scrape({ url: start, followMetaRefresh: true }, deps)).rejects.toThrow("browser-needed")
    await expect(scrape({ url: start, followMetaRefresh: true, maxTier: 1 }, deps)).rejects.toThrow("Max tier")
  })

  test("keeps the crossed-landing guard active with certificate errors ignored", async () => {
    const site = makeSite({ [start]: `<meta http-equiv=refresh content="0; ${FINAL}">` })
    await expect(
      scrape(
        { url: start, followMetaRefresh: true, ignoreCertificateErrors: true, maxTier: 3 },
        {
          ...deps,
          acquireBrowser: async () => site.handle,
          landingProbe: async () => "127.0.0.1",
        },
      ),
    ).rejects.toThrow("refused crossed landing")
    expect(site.closed()).toBe(1)
  })

  test("cached sessions receive the flag and follow before returning", async () => {
    const site = makeSite({ [start]: `<meta http-equiv=refresh content="0; ${FINAL}">` })
    const result = await scrape(
      { url: start, followMetaRefresh: true, maxTier: 2 },
      {
        ...deps,
        acquireBrowser: async () => site.handle,
        loadSession: async () => session,
      },
    )
    expect(result.tier).toBe(2)
    expect(result.url).toBe(FINAL)
    expect(result.timings[0]?.reason).toBe("meta-refresh-needs-browser")
  })
})
