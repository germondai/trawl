import { expect, test } from "bun:test"
import type { Page } from "patchright"
import { ExternalCaptchaSession } from "../src/solvers/externalCaptcha"

const options = { apiKey: "owned-test-key", maxTasks: 1, timeoutMs: 10000, localTimeoutMs: 100 }
function fixture() {
  const applied: unknown[] = []
  const page = {
    url: () => "https://example.com/owned-fixture",
    evaluate: async (_fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return { sitekey: "owned-sitekey", callback: null, invisible: false }
      applied.push(arg)
      return true
    },
  } as unknown as Page
  return { page, applied }
}
function provider(replies: unknown[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json(replies.shift())
  }
  return { calls, fetcher: fetcher as typeof fetch }
}

test("external solving creates one task and applies its token to the same page", async () => {
  const { page, applied } = fixture()
  const { calls, fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "owned-response" } },
  ])
  const session = new ExternalCaptchaSession(options, fetcher, async () => {})
  expect(await session.solve(page, "recaptcha-v2", 10000)).toBe(true)
  expect(calls.map((c) => c.url)).toEqual([
    "https://api.2captcha.com/createTask",
    "https://api.2captcha.com/getTaskResult",
  ])
  expect(calls[0]?.body.task).toMatchObject({
    type: "RecaptchaV2TaskProxyless",
    websiteKey: "owned-sitekey",
    websiteURL: page.url(),
  })
  expect(applied).toHaveLength(1)
  expect(await session.solve(page, "turnstile", 10000)).toBe(false)
  expect(calls).toHaveLength(2)
})

test("provider errors and malformed solutions do not become successful solves", async () => {
  for (const reply of [
    { errorId: 12, errorCode: "ERROR_CAPTCHA_UNSOLVABLE" },
    { errorId: 0, status: "ready", solution: {} },
    { status: "ready", solution: { token: "owned-response" } },
  ]) {
    const { page, applied } = fixture()
    const { fetcher } = provider([{ errorId: 0, taskId: 42 }, reply])
    expect(await new ExternalCaptchaSession(options, fetcher, async () => {}).solve(page, "turnstile", 10000)).toBe(
      false,
    )
    expect(applied).toHaveLength(0)
  }
})

test("ambiguous creation failures consume the task allowance without retrying", async () => {
  let calls = 0
  const fetcher = (async () => {
    calls++
    throw new Error("owned network failure")
  }) as unknown as typeof fetch
  const { page } = fixture()
  const session = new ExternalCaptchaSession(options, fetcher, async () => {})
  expect(await session.solve(page, "turnstile", 10000)).toBe(false)
  expect(await session.solve(page, "turnstile", 10000)).toBe(false)
  expect(calls).toBe(1)
})

test("unsupported types, expired budgets and cancellation create no paid tasks", async () => {
  const { page } = fixture()
  const { calls, fetcher } = provider([])
  const session = new ExternalCaptchaSession(options, fetcher)
  expect(await session.solve(page, "hcaptcha", 10000)).toBe(false)
  expect(await session.solve(page, "turnstile", 0)).toBe(false)
  expect(await session.solve(page, "turnstile", 10000, AbortSignal.abort())).toBe(false)
  expect(calls).toHaveLength(0)
})

test("explicit browser proxy is forwarded without silently falling back to proxyless", async () => {
  const { page } = fixture()
  const { calls, fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { token: "owned-response" } },
  ])
  const session = new ExternalCaptchaSession(options, fetcher, async () => {})
  expect(
    await session.solve(
      page,
      "turnstile",
      10000,
      undefined,
      "socks5://fixture-user:fixture-pass@proxy.example.com:1080",
    ),
  ).toBe(true)
  expect(calls[0]?.body.task).toMatchObject({
    type: "TurnstileTask",
    proxyType: "socks5",
    proxyAddress: "proxy.example.com",
    proxyPort: 1080,
    proxyLogin: "fixture-user",
    proxyPassword: "fixture-pass",
  })
})

test("external fallback reserves time while an allowance remains", () => {
  const session = new ExternalCaptchaSession(options)
  expect(session.localBudget(60_000)).toBe(100)
  expect(session.localBudget(50)).toBe(25)
})

test("processing results poll the same task and never recreate it", async () => {
  const { page } = fixture()
  const { calls, fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "processing" },
    { errorId: 0, status: "ready", solution: { token: "owned-response" } },
  ])
  const pauses: number[] = []
  expect(
    await new ExternalCaptchaSession({ ...options, timeoutMs: 15000 }, fetcher, async (ms) => {
      pauses.push(ms)
    }).solve(page, "turnstile", 15000),
  ).toBe(true)
  expect(pauses).toEqual([5000, 5000])
  expect(calls.slice(1).map((c) => c.body.taskId)).toEqual([42, 42])
  expect(calls.filter((c) => c.url.endsWith("createTask"))).toHaveLength(1)
})

test("navigation during provider processing refuses stale token injection", async () => {
  const { page, applied } = fixture()
  const { fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { token: "owned-response" } },
  ])
  const pause = async () => {
    page.url = () => "https://example.com/other-page"
  }
  expect(await new ExternalCaptchaSession(options, fetcher, pause).solve(page, "turnstile", 10000)).toBe(false)
  expect(applied).toHaveLength(0)
})

test("provider fetches stop on cancellation", async () => {
  const { page } = fixture()
  const controller = new AbortController()
  let aborted = false
  const fetcher = (async (_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true
          reject(new Error("owned abort"))
        },
        { once: true },
      )
      controller.abort()
    })) as unknown as typeof fetch
  expect(await new ExternalCaptchaSession(options, fetcher).solve(page, "turnstile", 10000, controller.signal)).toBe(
    false,
  )
  expect(aborted).toBe(true)
})

test("short remaining budgets do not create tasks that cannot be polled", async () => {
  const { page } = fixture()
  const { calls, fetcher } = provider([])
  expect(await new ExternalCaptchaSession(options, fetcher).solve(page, "turnstile", 5000)).toBe(false)
  expect(calls).toHaveLength(0)
})

test("the provider wait shares the deadline and does not inject a late result", async () => {
  const { page, applied } = fixture()
  const { calls, fetcher } = provider([{ errorId: 0, taskId: 42 }])
  const pause = async (_ms: number, signal?: AbortSignal) => {
    await Bun.sleep(5100)
    signal?.throwIfAborted()
  }
  const start = Date.now()
  expect(await new ExternalCaptchaSession(options, fetcher, pause).solve(page, "turnstile", 5050)).toBe(false)
  expect(Date.now() - start).toBeLessThan(5500)
  expect(calls).toHaveLength(1)
  expect(applied).toHaveLength(0)
}, 8000)

test("unsupported proxy protocols and inherited object names create no tasks", async () => {
  const { page } = fixture()
  const { calls, fetcher } = provider([])
  const session = new ExternalCaptchaSession(options, fetcher)
  expect(await session.solve(page, "turnstile", 10000, undefined, "https://proxy.example.com:443")).toBe(false)
  expect(await session.solve(page, "toString", 10000)).toBe(false)
  expect(calls).toHaveLength(0)
})

test("failed token delivery is not reported as solved", async () => {
  const { page } = fixture()
  const evaluate = page.evaluate
  page.evaluate = (async (fn: unknown, arg: unknown) =>
    typeof arg === "string" ? evaluate(fn as never, arg) : false) as Page["evaluate"]
  const { fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { token: "owned-response" } },
  ])
  expect(await new ExternalCaptchaSession(options, fetcher, async () => {}).solve(page, "turnstile", 10000)).toBe(false)
})

test("cancellation also stops an operation waiting for browser metadata", async () => {
  const { page } = fixture()
  let entered = () => {}
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  page.evaluate = (async () => {
    entered()
    return new Promise(() => {})
  }) as Page["evaluate"]
  const controller = new AbortController()
  const result = new ExternalCaptchaSession(options).solve(page, "turnstile", 10000, controller.signal)
  await reading
  controller.abort()
  expect(await Promise.race([result, Bun.sleep(100).then(() => "still-running")])).toBe(false)
})

test("recaptcha.net metadata and browser identity are included in the task", async () => {
  const { page } = fixture()
  page.evaluate = (async (_fn: unknown, arg: unknown) =>
    typeof arg === "string"
      ? {
          sitekey: "owned-key",
          callback: null,
          invisible: true,
          apiDomain: "recaptcha.net",
          userAgent: "owned-browser-agent",
          dataS: "owned-data-s",
        }
      : true) as Page["evaluate"]
  const { calls, fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "owned-response" } },
  ])
  expect(await new ExternalCaptchaSession(options, fetcher, async () => {}).solve(page, "recaptcha-v2", 10000)).toBe(
    true,
  )
  expect(calls[0]?.body.task).toMatchObject({
    apiDomain: "recaptcha.net",
    userAgent: "owned-browser-agent",
    isInvisible: true,
    recaptchaDataSValue: "owned-data-s",
  })
})

test("temporary polling failures retry the existing task without another charge", async () => {
  const { page } = fixture()
  let creates = 0
  let polls = 0
  const fetcher = (async (url: unknown) => {
    if (String(url).endsWith("createTask")) {
      creates++
      return Response.json({ errorId: 0, taskId: 42 })
    }
    if (++polls === 1) return new Response("Owned temporary outage", { status: 503 })
    return Response.json({ errorId: 0, status: "ready", solution: { token: "owned-response" } })
  }) as unknown as typeof fetch
  expect(await new ExternalCaptchaSession(options, fetcher, async () => {}).solve(page, "turnstile", 10000)).toBe(true)
  expect(creates).toBe(1)
  expect(polls).toBe(2)
})

test("zero-balance cooldown is shared across scrapes using the same provider configuration", async () => {
  const config = { ...options }
  const { page } = fixture()
  const { calls, fetcher } = provider([{ errorId: 10, errorCode: "ERROR_ZERO_BALANCE" }])
  expect(await new ExternalCaptchaSession(config, fetcher).solve(page, "turnstile", 10000)).toBe(false)
  const next = new ExternalCaptchaSession(config, fetcher)
  expect(next.supports("turnstile")).toBe(false)
  expect(await next.solve(page, "turnstile", 10000)).toBe(false)
  expect(calls).toHaveLength(1)
})

test("a main-frame reload at the same URL aborts token delivery and removes its listener", async () => {
  const { page, applied } = fixture()
  let listener: ((frame: unknown) => void) | undefined
  const main = {}
  page.mainFrame = (() => main) as Page["mainFrame"]
  page.on = ((_event: unknown, fn: unknown) => {
    listener = fn as typeof listener
    return page
  }) as Page["on"]
  page.off = ((_event: unknown, fn: unknown) => {
    if (fn === listener) listener = undefined
    return page
  }) as Page["off"]
  const { calls, fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { token: "owned-response" } },
  ])
  const pause = async () => {
    listener?.(main)
  }
  expect(await new ExternalCaptchaSession(options, fetcher, pause).solve(page, "turnstile", 10000)).toBe(false)
  expect(calls).toHaveLength(1)
  expect(applied).toHaveLength(0)
  expect(listener).toBeUndefined()
})

test("repeated transport failures stop polling without recreating the paid task", async () => {
  const { page, applied } = fixture()
  let creates = 0
  let polls = 0
  const fetcher = (async (url: unknown) => {
    if (String(url).endsWith("createTask")) {
      creates++
      return Response.json({ errorId: 0, taskId: 42 })
    }
    polls++
    return new Response("Owned outage", { status: 503 })
  }) as unknown as typeof fetch
  expect(await new ExternalCaptchaSession(options, fetcher, async () => {}).solve(page, "turnstile", 10000)).toBe(false)
  expect(creates).toBe(1)
  expect(polls).toBe(3)
  expect(applied).toHaveLength(0)
})

test("no-slot and rate-limit responses pause new tasks across scrapes", async () => {
  for (const reply of [
    Response.json({ errorId: 2, errorCode: "ERROR_NO_SLOT_AVAILABLE" }),
    new Response("Owned rate limit", { status: 429 }),
  ]) {
    const config = { ...options }
    const { page } = fixture()
    let calls = 0
    const fetcher = (async () => {
      calls++
      return reply
    }) as unknown as typeof fetch
    expect(await new ExternalCaptchaSession(config, fetcher).solve(page, "turnstile", 10000)).toBe(false)
    expect(await new ExternalCaptchaSession(config, fetcher).canSolve(page, "turnstile")).toBe(false)
    expect(calls).toBe(1)
  }
})

test("changed widget metadata rejects a token even when the page URL is unchanged", async () => {
  const { page, applied } = fixture()
  let changed = false
  const evaluate = page.evaluate
  page.evaluate = (async (fn: unknown, arg: unknown) => {
    if (changed && typeof arg === "string") return { sitekey: "new-sitekey", callback: null, invisible: false }
    return evaluate(fn as never, arg)
  }) as Page["evaluate"]
  const { fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { token: "owned-response" } },
  ])
  expect(
    await new ExternalCaptchaSession(options, fetcher, async () => {
      changed = true
    }).solve(page, "turnstile", 10000),
  ).toBe(false)
  expect(applied).toHaveLength(0)
})

test("a slow creation response never shortens the minimum polling interval", async () => {
  const { page } = fixture()
  const calls: string[] = []
  const fetcher = (async (url: unknown) => {
    calls.push(String(url))
    await Bun.sleep(600)
    return Response.json({ errorId: 0, taskId: 42 })
  }) as unknown as typeof fetch
  const pauses: number[] = []
  expect(
    await new ExternalCaptchaSession(options, fetcher, async (ms) => {
      pauses.push(ms)
    }).solve(page, "turnstile", 5500),
  ).toBe(false)
  expect(calls).toEqual(["https://api.2captcha.com/createTask"])
  expect(pauses).toHaveLength(0)
})

test("Enterprise widgets use the Enterprise task and enterprisePayload", async () => {
  const { page, applied } = fixture()
  page.evaluate = (async (_fn: unknown, arg: unknown) => {
    if (typeof arg === "string")
      return { sitekey: "owned-sitekey", enterprise: true, dataS: "owned-s", userAgent: "owned-UA" }
    applied.push(arg)
    return true
  }) as Page["evaluate"]
  const { calls, fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "owned-response" } },
  ])
  const session = new ExternalCaptchaSession(options, fetcher, async () => {})
  expect(await session.canSolve(page, "recaptcha-v2")).toBe(false)
  expect(await session.solve(page, "recaptcha-v2-enterprise", 10000)).toBe(true)
  expect(calls[0]?.body.task).toMatchObject({
    type: "RecaptchaV2EnterpriseTaskProxyless",
    enterprisePayload: { s: "owned-s" },
  })
  expect(calls[0]?.body.task).not.toHaveProperty("recaptchaDataSValue")
})

test("a provider user agent that differs from the browser cannot deliver a result", async () => {
  const { page, applied } = fixture()
  const { fetcher } = provider([
    { errorId: 0, taskId: 42 },
    { errorId: 0, status: "ready", solution: { token: "owned-response", userAgent: "other-UA" } },
  ])
  // The metadata fixture returns true for the browser identity; a mismatched result is rejected.
  const session = new ExternalCaptchaSession(options, fetcher, async () => {})
  expect(await session.solve(page, "turnstile", 10000)).toBe(false)
  expect(session.diagnostics()).toContainEqual({ kind: "turnstile", status: "identity-mismatch" })
  expect(applied.filter((value) => typeof value === "object")).toHaveLength(0)
})

test("oversized provider responses are cancelled without creating another task", async () => {
  let cancelled = false
  let calls = 0
  const fetcher = (async () => {
    calls++
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(512001))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  }) as unknown as typeof fetch
  const { page } = fixture()
  const session = new ExternalCaptchaSession(options, fetcher, async () => {})
  expect(await session.solve(page, "turnstile", 10000)).toBe(false)
  expect(cancelled).toBe(true)
  expect(calls).toBe(1)
  expect(session.supports("turnstile")).toBe(false)
})
