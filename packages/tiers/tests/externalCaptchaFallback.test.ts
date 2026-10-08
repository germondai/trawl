import { expect, test } from "bun:test"
import type { Page } from "patchright"
import { solvePageCaptchas } from "../src/solvers"
import { ExternalCaptchaSession } from "../src/solvers/externalCaptcha"

function widget(autoPass: boolean, eligible = true) {
  const page = {
    url: () => "https://example.com/owned-fixture",
    content: async () => '<div class="cf-turnstile" data-sitekey="owned-key"></div>',
    frames: () => [],
    evaluate: async (fn: unknown, arg: unknown) => {
      if (typeof arg === "string") return eligible ? { sitekey: "owned-key", callback: null, invisible: false } : null
      if (typeof arg === "object" && arg !== null) return true
      const code = String(fn)
      if (code.includes('return "iframe"')) return "iframe"
      if (code.includes("const valid")) return autoPass
      return undefined
    },
  } as unknown as Page
  return page
}

function session() {
  const calls: string[] = []
  const fetcher = (async (url: unknown) => {
    calls.push(String(url))
    return Response.json(
      String(url).endsWith("createTask")
        ? { errorId: 0, taskId: 42 }
        : { errorId: 0, status: "ready", solution: { token: "owned-response" } },
    )
  }) as unknown as typeof fetch
  return {
    calls,
    external: new ExternalCaptchaSession(
      { apiKey: "owned-key", maxTasks: 1, localTimeoutMs: 10, timeoutMs: 10000 },
      fetcher,
      async () => {},
    ),
  }
}

test("a successful built-in solver never submits an external task", async () => {
  const { external, calls } = session()
  expect(await solvePageCaptchas(widget(true), 10000, undefined, external)).toEqual({
    attempted: ["turnstile"],
    solved: ["turnstile"],
  })
  expect(calls).toHaveLength(0)
})

test("external fallback runs only after local solving fails", async () => {
  const { external, calls } = session()
  expect(await solvePageCaptchas(widget(false), 10000, undefined, external)).toEqual({
    attempted: ["turnstile", "turnstile:2captcha"],
    solved: ["turnstile:2captcha"],
  })
  expect(calls).toHaveLength(2)
})

test("unsupported widget markup preserves local-only behavior without spending", async () => {
  const { external, calls } = session()
  expect(await solvePageCaptchas(widget(true, false), 10000, undefined, external)).toEqual({
    attempted: ["turnstile"],
    solved: ["turnstile"],
  })
  expect(calls).toHaveLength(0)
})

test("without an external session, failed local solving makes no provider request", async () => {
  expect(await solvePageCaptchas(widget(false), 30)).toEqual({ attempted: ["turnstile"], solved: [] })
})
