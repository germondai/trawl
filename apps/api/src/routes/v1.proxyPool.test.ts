import { expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { type OrchestratorDeps, ProxyPool, scrape } from "@trawl/tiers"
import { MetricsStore } from "../metrics"
import { v1Route } from "./v1"

const A = "http://datacenter-a.example:8080"
const B = "http://datacenter-b.example:8080"
const R = "http://residential.example:8080"
const target = "https://target.example/"
const ok = { status: "success" as const, durationMs: 1, html: "<html>fixture</html>", statusCode: 200 }
const blocked = { status: "blocked" as const, durationMs: 1, reason: "fixture-blocked" }
type Runners = NonNullable<Parameters<typeof scrape>[2]>

function deps(minTier: 3 | 4): OrchestratorDeps {
  return {
    minTier,
    proxyPool: new ProxyPool([A, B]),
    residentialProxyPool: new ProxyPool([R]),
    acquireBrowser: async () =>
      ({
        id: 1,
        lease: 1,
        headful: false,
        fingerprint: { userAgent: "fixture" },
        browser: {},
      }) as BrowserHandle,
    releaseBrowser() {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
}

async function request(d: OrchestratorDeps, runners: Runners, proxy: unknown = {}) {
  const metrics = new MetricsStore(false)
  const app = v1Route({
    poolReady: () => true,
    cookieFallback: false,
    metricsStore: metrics,
    orchestratorDeps: () => d,
    runScrape: (req, actualDeps) => scrape(req, actualDeps, runners),
  })
  try {
    const response = await app.handle(
      new Request("http://localhost/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url: target, maxTimeout: 10000, proxy }),
      }),
    )
    return { status: response.status, body: await response.json() }
  } finally {
    metrics.close()
  }
}

test("/v1 retries a blocked configured proxy before residential escalation", async () => {
  const calls: (string | undefined)[] = []
  const result = await request(deps(3), {
    tier3: async (_url, _handle, _timeout, proxy) => {
      calls.push(proxy)
      return { tier: 3, ...(proxy === B ? ok : blocked) }
    },
    tier4: async (_url, _handle, _timeout, proxy) => {
      calls.push(proxy)
      return { tier: 4, ...blocked }
    },
  })
  expect(calls).toEqual([A, B])
  expect(result.status).toBe(200)
  expect(result.body.status).toBe("ok")
})

test("/v1 honors the residential proxy when the minimum tier is 4", async () => {
  const calls: (string | undefined)[] = []
  const result = await request(deps(4), {
    tier4: async (_url, _handle, _timeout, proxy) => {
      calls.push(proxy)
      return { tier: 4, ...ok }
    },
  })
  expect(calls).toEqual([R])
  expect(result.status).toBe(200)
})

test("/v1 does not require an available datacenter proxy at the tier 4 floor", async () => {
  const d = deps(4)
  d.proxyPool?.markBad(A)
  d.proxyPool?.markBad(B)
  const calls: (string | undefined)[] = []
  const result = await request(d, {
    tier4: async (_url, _handle, _timeout, proxy) => {
      calls.push(proxy)
      return { tier: 4, ...ok }
    },
  })
  expect(calls).toEqual([R])
  expect(result.status).toBe(200)
})

test("/v1 keeps an explicit proxy at the tier 4 floor", async () => {
  const calls: (string | undefined)[] = []
  const result = await request(
    deps(4),
    {
      tier4: async (_url, _handle, _timeout, proxy) => {
        calls.push(proxy)
        return { tier: 4, ...ok }
      },
    },
    A,
  )
  expect(calls).toEqual([A])
  expect(result.status).toBe(200)
})

test("/v1 never substitutes the datacenter pool for a required residential proxy", async () => {
  const d = deps(4)
  d.residentialProxyPool = undefined
  let called = false
  const result = await request(d, {
    tier4: async () => {
      called = true
      return { tier: 4, ...ok }
    },
  })
  expect(result.status).toBe(500)
  expect(result.body.message).toContain("Tier 4 requires")
  expect(called).toBe(false)
})

test.each([A, { url: A, username: "", password: "" }])(
  "/v1 keeps explicit proxy %j pinned across tiers",
  async (proxy) => {
    const calls: (string | undefined)[] = []
    const result = await request(
      deps(3),
      {
        tier3: async (_url, _handle, _timeout, selected) => {
          calls.push(selected)
          return { tier: 3, ...blocked }
        },
        tier4: async (_url, _handle, _timeout, selected) => {
          calls.push(selected)
          return { tier: 4, ...blocked }
        },
      },
      proxy,
    )
    expect(calls).toEqual([A, A])
    expect(result.status).toBe(500)
  },
)

test("/v1 fails closed when every configured proxy is cooling down", async () => {
  const d = deps(3)
  d.proxyPool?.markBad(A)
  d.proxyPool?.markBad(B)
  let called = false
  const result = await request(d, {
    tier3: async () => {
      called = true
      return { tier: 3, ...ok }
    },
  })
  expect(result.status).toBe(503)
  expect(result.body.message).toBe("proxy-connection-failed")
  expect(called).toBe(false)
})
