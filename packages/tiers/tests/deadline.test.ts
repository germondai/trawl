import { afterAll, describe, expect, test } from "bun:test"
import { scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { DeadlineError, RequestBudget } from "../src/utils/deadline"
import { hasImpervaChallenge } from "../src/utils/detect"

const fixture = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/headers") await Bun.sleep(500)
    if (path === "/cloudflare")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html><title>Just a moment</title>"))
          },
        }),
        {
          status: 403,
          headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
        },
      )
    if (path === "/slow-body")
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("Po"))
            await Bun.sleep(120)
            controller.enqueue(new TextEncoder().encode("ng"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/plain", server: "cloudflare" } },
      )
    return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/html" } })
  },
})
afterAll(() => fixture.stop(true))
const deps = {
  acquireBrowser: async () => {
    throw new Error("must not acquire")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
}

describe("scrape deadline", () => {
  test("escalates a Cloudflare challenge before its open body consumes the deadline", async () => {
    const operation = scrape(
      { url: `${fixture.url}cloudflare`, maxTimeout: 250, maxTier: 3 },
      {
        ...deps,
        acquireBrowser: async () => {
          throw new Error("Browser fallback reached")
        },
      },
    )
    await expect(operation).rejects.toThrow("Browser fallback reached")
  })

  test.each([undefined, fixture.url.href])("bounds response-header silence with proxy %s", async (proxy) => {
    const result = await runTier1(
      `${fixture.url}headers`,
      undefined,
      undefined,
      undefined,
      proxy,
      undefined,
      undefined,
      undefined,
      AbortSignal.timeout(250),
      undefined,
      1000,
      40,
    )
    expect(result.reason).toBe("tier1-response-timeout")
    expect(result.durationMs).toBeLessThan(200)
  })

  test("keeps the full body deadline after ordinary response headers arrive", async () => {
    const result = await runTier1(
      `${fixture.url}slow-body`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      AbortSignal.timeout(500),
      undefined,
      500,
      40,
    )
    expect(result.status).toBe("success")
    expect(result.html).toBe("Pong")
  })

  test("uses the configured default when a request omits maxTimeout", async () => {
    const configuredDeps = { ...deps, defaultMaxTimeout: 60 }
    const result = await Promise.race([
      scrape({ url: `${fixture.url}headers`, maxTier: 1 }, configuredDeps).then(
        () => "success",
        (error: Error) => error.message,
      ),
      Bun.sleep(350).then(() => "still-running"),
    ])
    expect(result).toBe("Scrape deadline exceeded")
  })

  test.each(["headers", "body"])("stops a stalled HTTP %s within the request budget", async (path) => {
    const start = performance.now()
    const operation = scrape({ url: `${fixture.url}${path}`, maxTimeout: 60, maxTier: 1 }, deps)
    const result = await Promise.race([
      operation.then(
        () => "success",
        () => "stopped",
      ),
      Bun.sleep(350).then(() => "still-running"),
    ])
    expect(result).toBe("stopped")
    expect(performance.now() - start).toBeLessThan(300)
  })
  test("recognizes the observed Imperva interruption wall without matching an article", () => {
    const wall =
      "<html><head><title>Pardon Our Interruption</title></head><body>As you were browsing something about your browser made us think you were a bot. Please enable JavaScript.</body></html>"
    expect(hasImpervaChallenge(wall)).toBeTrue()
    expect(
      hasImpervaChallenge(
        "<html><head><title>Pardon Our Interruption</title></head><body><article>A discussion of website error messages.</article></body></html>",
      ),
    ).toBeFalse()
  })
})

test("deadline closes the owned context and releases its browser lease", async () => {
  let closeCalls = 0
  let releases = 0
  let cancelNavigation!: () => void
  const page = {
    setDefaultTimeout() {},
    on() {},
    off() {},
    goto: () =>
      new Promise<void>((_, reject) => {
        cancelNavigation = () => reject(new Error("page closed"))
      }),
    content: async () => "",
    frames: () => [],
    url: () => "https://example.test/",
  }
  const context = {
    addInitScript: async () => {},
    cookies: async () => [],
    newPage: async () => page,
    close: async () => {
      closeCalls++
      cancelNavigation?.()
    },
  }
  const handle = {
    id: 1,
    lease: 1,
    headful: false,
    context,
    browser: { newContext: async () => context },
    fingerprint: { userAgent: "test", platform: "Win32" as const, locale: "en-US", timezone: "UTC" },
  }
  await expect(
    scrape(
      { url: "https://example.test/", skipHttp: true, maxTimeout: 60, maxTier: 3 },
      {
        ...deps,
        acquireBrowser: async () => handle,
        releaseBrowser: () => {
          releases++
        },
      },
    ),
  ).rejects.toThrow("deadline")
  expect(closeCalls).toBe(1)
  expect(releases).toBe(1)
})

test.each([2, 3] as const)(
  "deadline cleans up pending tier %i resource creation before releasing the lease",
  async (tier) => {
    let closed = false
    let releases = 0
    let navigationCalls = 0
    const page = {
      close: async () => {
        closed = true
      },
      goto: async () => {
        navigationCalls++
      },
    }
    const context = {
      addInitScript: async () => {},
      newPage: async () => {
        if (tier === 2) await Bun.sleep(80)
        return page
      },
      close: async () => {
        closed = true
      },
    }
    const handle = {
      id: 1,
      lease: 1,
      headful: false,
      context,
      browser: {
        newContext: async () => {
          await Bun.sleep(80)
          return context
        },
      },
      fingerprint: { userAgent: "test", platform: "Win32" as const, locale: "en-US", timezone: "UTC" },
    }
    await expect(
      scrape(
        { url: "https://example.test/", skipHttp: true, maxTimeout: 20, maxTier: tier },
        {
          ...deps,
          loadSession: async () => (tier === 2 ? { cookies: [], userAgent: "test", savedAt: Date.now() } : undefined),
          acquireBrowser: async () => handle,
          releaseBrowser: () => {
            expect(closed).toBeTrue()
            releases++
          },
        },
      ),
    ).rejects.toThrow("deadline")
    expect(closed).toBeTrue()
    expect(releases).toBe(1)
    expect(navigationCalls).toBe(0)
    await Bun.sleep(10)
    expect(releases).toBe(1)
  },
)

test("a browser acquired after cancellation is released without starting a tier", async () => {
  let releases = 0
  const handle = {
    id: 1,
    lease: 1,
    headful: false,
    context: {},
    browser: {},
    fingerprint: { userAgent: "test", platform: "Win32" as const, locale: "en-US", timezone: "UTC" },
  }
  await expect(
    scrape(
      { url: "https://example.test/", skipHttp: true, maxTimeout: 20 },
      {
        ...deps,
        acquireBrowser: async () => {
          await Bun.sleep(50)
          return handle
        },
        releaseBrowser: () => {
          releases++
        },
      },
    ),
  ).rejects.toThrow("Browser pool exhausted")
  await Bun.sleep(60)
  expect(releases).toBe(1)
})

test("an expired deadline takes precedence over a transport rejection before the timer callback", async () => {
  const budget = new RequestBudget(20)
  let cleaned = false
  budget.own(async () => {
    cleaned = true
  })
  try {
    const failure = await budget
      .run(async () => {
        // Delay timer callbacks so the transport rejection reaches the budget first.
        Bun.sleepSync(25)
        throw new Error("TLS request timed out")
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeadlineError)
    expect(budget.signal.aborted).toBeTrue()
    expect(cleaned).toBeTrue()
  } finally {
    budget.dispose()
  }
})
