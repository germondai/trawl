import { afterAll, describe, expect, test } from "bun:test"
import type { AcquireOptions, OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { DATADOME_INTERSTITIAL } from "./fixtures/datadome"

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/datadome") {
      return new Response(DATADOME_INTERSTITIAL, {
        status: 403,
        headers: { "content-type": "text/html", "x-dd-b": "1" },
      })
    }
    return new Response("<html><head><title>Just a moment...</title></head><body></body></html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })
  },
})

afterAll(() => server.stop(true))

const baseUrl = `http://127.0.0.1:${server.port}`

// The stub throws once the routing decision is visible: acquiring is as far as this test
// needs to run.
function recordingDeps() {
  const acquired: Array<AcquireOptions | undefined> = []
  const deps: OrchestratorDeps = {
    acquireBrowser: async (_domain, _budgetMs, options) => {
      acquired.push(options)
      throw new Error("routing recorded")
    },
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  return { deps, acquired }
}

describe("headful pool routing", () => {
  test("a DataDome wall in Tier 1 asks for a headful browser", async () => {
    const { deps, acquired } = recordingDeps()
    await scrape({ url: `${baseUrl}/datadome` }, deps).catch(() => {})
    expect(acquired).toEqual([{ headful: true }])
  })

  test("every other wall stays on the headless pool", async () => {
    const { deps, acquired } = recordingDeps()
    await scrape({ url: `${baseUrl}/cloudflare` }, deps).catch(() => {})
    expect(acquired).toEqual([{ headful: false }])
  })

  test("a request that skips Tier 1 cannot know the wall and stays headless", async () => {
    const { deps, acquired } = recordingDeps()
    await scrape({ url: `${baseUrl}/datadome`, skipHttp: true }, deps).catch(() => {})
    expect(acquired).toEqual([{ headful: false }])
  })
})
