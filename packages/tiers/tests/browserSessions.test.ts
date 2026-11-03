import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { type BrowserHandle, FINGERPRINT } from "@trawl/browser"
import { BrowserSessions } from "../src/browserSessions"
import { scrape } from "../src/orchestrator"
import { RequestBudget } from "../src/utils/deadline"

const managers: BrowserSessions[] = []
const budgets: RequestBudget[] = []
afterEach(async () => {
  for (const budget of budgets.splice(0)) budget.dispose()
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
})
const budget = (ms = 1000) => {
  const value = new RequestBudget(ms)
  budgets.push(value)
  return value
}
interface KeptFakePage {
  closed: boolean
  evaluateCalls: string[]
  frame: { evaluateCalls: number; evaluate(fn: unknown): Promise<unknown> }
  evaluate(expression: string): Promise<unknown>
  isClosed(): boolean
  frames(): { evaluate(fn: unknown): Promise<unknown> }[]
  close(): Promise<void>
}
interface SessionTestContext extends EventEmitter {
  closed: boolean
  jar: unknown[]
  pageList: KeptFakePage[]
  pages(): { close(): Promise<void> }[]
  newPage(): Promise<KeptFakePage>
  cookies(): Promise<unknown[]>
  addInitScript(): Promise<void>
  close(): Promise<void>
}
function fixture(
  options: {
    maxSessions?: number
    ttlMs?: number
    now?: () => number
    networkProxy?: (upstream?: string) => Promise<string>
  } = {},
) {
  const contexts: SessionTestContext[] = []
  const acquires: { browserId?: number; headful?: boolean }[] = []
  const releases: BrowserHandle[] = []
  const contextOptions: unknown[] = []
  let retained = 0
  const browser = {
    async newContext(options?: unknown) {
      contextOptions.push(options)
      const context = Object.assign(new EventEmitter(), {
        closed: false,
        jar: [] as unknown[],
        pageList: [] as KeptFakePage[],
        pages() {
          return context.pageList.filter((page) => !page.closed)
        },
        async newPage() {
          const page: KeptFakePage = {
            closed: false,
            evaluateCalls: [],
            frame: {
              evaluateCalls: 0,
              evaluate: async () => {
                page.frame.evaluateCalls++
                return null
              },
            },
            evaluate: async (expression: string) => {
              page.evaluateCalls.push(expression)
              expression = expression.replace(/^mw:/, "")
              if (expression === "window.answer") return 42
              if (expression === "never-resolves") return new Promise(() => {})
              return undefined
            },
            isClosed: () => page.closed,
            frames: () => [page.frame],
            close: async () => {
              page.closed = true
            },
          }
          context.pageList.push(page)
          return page
        },
        cookies: async () => context.jar,
        addInitScript: async () => {},
        async close() {
          context.closed = true
          for (const page of context.pageList) page.closed = true
          context.emit("close")
        },
      }) as SessionTestContext
      contexts.push(context)
      return context
    },
  }
  const handle: BrowserHandle = {
    id: 7,
    lease: 1,
    headful: false,
    browser,
    context: {},
    fingerprint: FINGERPRINT,
    retainBrowser() {
      retained++
      let released = false
      return () => {
        if (!released) retained--
        released = true
      }
    },
  }
  const deps = {
    acquireBrowser: async (_domain: string, _ms: number, options: { browserId?: number; headful?: boolean }) => {
      acquires.push(options)
      return handle
    },
    releaseBrowser: (handle: BrowserHandle) => {
      releases.push(handle)
    },
  }
  const sessions = new BrowserSessions({ ...deps, ...options })
  managers.push(sessions)
  return { sessions, contexts, contextOptions, acquires, releases, handle, deps, retained: () => retained }
}

describe("browser sessions", () => {
  test("public-only sessions require guarded contexts while ordinary routing is preserved", async () => {
    await expect(fixture().sessions.create({ publicOnly: true })).rejects.toThrow("unavailable")
    const upstreams: (string | undefined)[] = []
    const f = fixture({
      networkProxy: async (upstream) => {
        upstreams.push(upstream)
        return "http://127.0.0.1:12345"
      },
    })
    const guarded = await f.sessions.create({
      id: "mcp",
      publicOnly: true,
      proxy: "http://operator-proxy.example:8080",
      keepPage: true,
    })
    expect(guarded.publicOnly).toBe(true)
    expect(f.contextOptions[0]).toMatchObject({ proxy: { server: "http://127.0.0.1:12345" } })
    expect(f.sessions.options("mcp").proxy).toBe("http://operator-proxy.example:8080")
    expect(upstreams).toEqual(["http://operator-proxy.example:8080"])
    const ordinary = await f.sessions.create({ id: "native", proxy: "http://native-proxy.example:8080" })
    expect(ordinary.publicOnly).toBeUndefined()
    expect(f.contextOptions[1]).toMatchObject({ proxy: { server: "http://native-proxy.example:8080" } })
    expect(upstreams).toHaveLength(1)
  })
  test("public-only admission checks the actual session entry before acquiring a browser", async () => {
    const f = fixture({ networkProxy: async () => "http://127.0.0.1:12345" })
    await f.sessions.create({ id: "replace", publicOnly: true })
    await f.sessions.destroy("replace")
    await f.sessions.create({ id: "replace" })
    const acquires = f.acquires.length
    await expect(f.sessions.use("replace", "a.example", budget(), async () => {}, true)).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(f.acquires).toHaveLength(acquires)
    await f.sessions.use("replace", "a.example", budget(), async () => {})
    expect(f.acquires).toHaveLength(acquires + 1)
  })
  test("compatibility creation is idempotent and age rotation preserves fixed routing", async () => {
    let now = 1
    const f = fixture({ now: () => now })
    const original = await f.sessions.create({ id: "compat", proxy: "http://proxy.example" })
    expect(await f.sessions.ensure("compat")).toEqual(original)
    now = 101
    expect((await f.sessions.ensure("compat", 200)).createdAt).toBe(1)
    const rotated = await f.sessions.ensure("compat", 50)
    expect(rotated.createdAt).toBe(101)
    expect(f.sessions.options("compat").proxy).toBe("http://proxy.example")
    expect(f.contexts[0].closed).toBeTrue()
    expect((await f.sessions.ensure("implicit")).id).toBe("implicit")
    expect(f.contexts).toHaveLength(3)
  })
  test("separate contexts survive requests without retaining a pool lease or exposing credentials", async () => {
    const f = fixture()
    await f.sessions.create({ id: "first", proxy: "http://user:password@proxy.example:8080", headful: true })
    await f.sessions.create({ id: "second" })
    const first = await f.sessions.use("first", "a.example", budget(), async (_, context) => context)
    expect(await f.sessions.use("first", "b.example", budget(), async (_, context) => context)).toBe(first)
    expect(await f.sessions.use("second", "a.example", budget(), async (_, context) => context)).not.toBe(first)
    expect(f.acquires.slice(2).every((options) => options.browserId === 7)).toBeTrue()
    expect(f.acquires[0].headful).toBeTrue()
    expect(f.releases).toHaveLength(5)
    expect(f.contexts).toHaveLength(2)
    expect(f.retained()).toBe(2)
    expect(JSON.stringify(await f.sessions.list())).not.toContain("password")
    await f.sessions.destroy("first")
    expect(f.contexts[0].closed).toBeTrue()
    expect(f.retained()).toBe(1)
    await expect(f.sessions.use("first", "", budget(), async () => {})).rejects.toMatchObject({ statusCode: 404 })
  })

  test("capacity, duplicate IDs, invalid IDs and expiry fail without evicting another login", async () => {
    let now = 1
    const f = fixture({ maxSessions: 1, ttlMs: 100, now: () => now })
    await f.sessions.create({ id: "login" })
    await expect(f.sessions.create({ id: "login" })).rejects.toMatchObject({ statusCode: 409 })
    await expect(f.sessions.create({ id: "other" })).rejects.toMatchObject({ statusCode: 429 })
    await expect(f.sessions.create({ id: "../login" })).rejects.toMatchObject({ statusCode: 400 })
    now = 90
    await f.sessions.use("login", "", budget(), async () => {})
    now = 110
    expect(await f.sessions.list()).toHaveLength(1)
    now = 191
    expect(await f.sessions.list()).toEqual([])
    expect(f.contexts[0].closed).toBeTrue()
    expect(f.retained()).toBe(0)
    await f.sessions.create({ id: "other" })
  })

  test("concurrent use and destroy return 409 while an active operation retains its context", async () => {
    const f = fixture()
    await f.sessions.create({ id: "login" })
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const running = f.sessions.use("login", "", budget(), async () => {
      entered()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    await started
    expect((await f.sessions.list())[0].busy).toBeTrue()
    await expect(f.sessions.use("login", "", budget(), async () => {})).rejects.toMatchObject({ statusCode: 409 })
    await expect(f.sessions.destroy("login")).rejects.toMatchObject({ statusCode: 409 })
    expect(f.contexts[0].closed).toBeFalse()
    finish()
    await running
    await f.sessions.destroy("login")
  })

  test("timeout closes the context before releasing its lease and invalidates the ID", async () => {
    const f = fixture()
    await f.sessions.create({ id: "login" })
    await expect(f.sessions.use("login", "", budget(15), async () => new Promise(() => {}))).rejects.toThrow("deadline")
    expect(f.contexts[0].closed).toBeTrue()
    expect(f.releases).toHaveLength(2)
    expect(f.retained()).toBe(0)
    expect(await f.sessions.list()).toEqual([])
  })

  test("a replaced browser never silently recreates the session", async () => {
    const f = fixture()
    await f.sessions.create({ id: "login" })
    f.handle.browser = {}
    await expect(f.sessions.use("login", "", budget(), async () => {})).rejects.toMatchObject({ statusCode: 410 })
    expect(await f.sessions.list()).toEqual([])
    expect(f.contexts[0].closed).toBeTrue()
  })

  test("browser context close removes the dead session, and shutdown disallows creation", async () => {
    const f = fixture()
    await f.sessions.create({ id: "login" })
    await f.contexts[0].close()
    expect(await f.sessions.list()).toEqual([])
    expect(f.retained()).toBe(0)
    await f.sessions.shutdown()
    await expect(f.sessions.create()).rejects.toMatchObject({ statusCode: 503 })
  })

  test("shutdown during acquisition cannot publish a late context", async () => {
    const f = fixture()
    await f.sessions.create({ id: "login" })
    let acquired!: (handle: BrowserHandle) => void
    f.deps.acquireBrowser = async () =>
      new Promise<BrowserHandle>((resolve) => {
        acquired = resolve
      })
    // The manager holds the same deps object passed by reference.
    const sessions = new BrowserSessions(f.deps)
    managers.push(sessions)
    const creating = sessions.create({ id: "late" })
    // Shutdown during acquisition must prevent a late context from becoming usable.
    await Bun.sleep(5)
    await sessions.shutdown()
    acquired(f.handle)
    await expect(creating).rejects.toMatchObject({ statusCode: 410 })
    expect(await sessions.list()).toEqual([])
    expect(f.contexts).toHaveLength(1)
  })
})

test("named scraping bypasses the implicit cache, preserves browser captures and enforces fixed policy", async () => {
  const f = fixture()
  await f.sessions.create({ id: "login" })
  let calls = 0
  const deps = {
    ...f.deps,
    sessions: f.sessions,
    loadSession: async () => {
      throw new Error("cache must not be read")
    },
    saveSession: async () => {
      throw new Error("login must not be cached")
    },
    invalidateSession: async () => {},
  }
  const result = await scrape({ url: "https://a.example", sessionId: "login", screenshot: true }, deps, {
    tier1: async () => {
      throw new Error("must use session browser")
    },
    tier3: async (_url, _handle, _ms, _proxy, _headers, _method, _body, _validate, _screenshot, capture) => {
      calls++
      expect(capture?.sessionContext).toBe(f.contexts[0])
      return {
        tier: 3,
        status: "success",
        durationMs: 1,
        html: "<html>signed in</html>",
        screenshot: "jpeg",
        cookies: [],
      }
    },
  })
  expect(result.screenshot).toBe("jpeg")
  expect(result.tier).toBe(3)
  expect(result.timings).toHaveLength(1)
  expect(calls).toBe(1)
  for (const flags of [{ maxTier: 2 as const }, { proxy: "http://other.example" }, { ignoreCertificateErrors: true }]) {
    await expect(scrape({ url: "https://a.example", sessionId: "login", ...flags }, deps)).rejects.toMatchObject({
      statusCode: 400,
    })
  }
})

test("default proxy selection is fixed once, invalid proxies fail closed, and Tier 4 requires a proxy", async () => {
  const f = fixture()
  let choices = 0
  const sessions = new BrowserSessions({
    ...f.deps,
    defaultProxy: () => {
      choices++
      return "http://proxy.example:8080"
    },
  })
  managers.push(sessions)
  await sessions.create({ id: "fixed" })
  await sessions.use("fixed", "", budget(), async () => {})
  expect(sessions.options("fixed").proxy).toBe("http://proxy.example:8080")
  expect(choices).toBe(1)
  for (const proxy of ["invalid", "file:///etc/passwd", "ftp://proxy.example", ""]) {
    await expect(sessions.create({ proxy })).rejects.toMatchObject({ statusCode: 400 })
  }
  const tier4 = new BrowserSessions({ ...f.deps, requireProxy: true })
  managers.push(tier4)
  await expect(tier4.create()).rejects.toMatchObject({ statusCode: 400 })
})

test("late acquisition after a use deadline releases exactly once without opening a context", async () => {
  const f = fixture()
  let acquire: (handle: BrowserHandle) => void = () => {}
  let wait = false
  const sessions = new BrowserSessions({
    ...f.deps,
    acquireBrowser: async (...args) =>
      wait
        ? new Promise<BrowserHandle>((resolve) => {
            acquire = resolve
          })
        : f.deps.acquireBrowser(...args),
  })
  managers.push(sessions)
  await sessions.create({ id: "late" })
  wait = true
  await expect(sessions.use("late", "", budget(15), async () => {})).rejects.toThrow("deadline")
  acquire(f.handle)
  await Bun.sleep(10)
  expect(f.releases).toHaveLength(2)
  expect(f.contexts).toHaveLength(1)
  expect(f.contexts[0].closed).toBeTrue()
})

test("closing all session pages includes popups and keeps the context storage alive", async () => {
  const f = fixture()
  await f.sessions.create({ id: "pages" })
  const closed: string[] = []
  f.contexts[0].pages = () =>
    ["document", "popup"]
      .filter((id) => !closed.includes(id))
      .map((id) => ({
        frames: () => [],
        close: async () => {
          closed.push(id)
        },
      }))
  await f.sessions.use("pages", "", budget(), async () => {})
  expect(closed).toEqual(["document", "popup"])
  expect(f.contexts[0].closed).toBeFalse()
})

test("storage snapshots isolate origins and retire oversized sessions", async () => {
  const f = fixture()
  await f.sessions.create({ id: "storage" })
  let closed = false
  let values: [string, string][] = [["login", "fixture"]]
  f.contexts[0].pages = () =>
    closed
      ? []
      : ([
          {
            frames: () => [{ evaluate: async () => ({ origin: "https://example.com", values }) }],
            close: async () => {
              closed = true
            },
          },
        ] as never)
  await f.sessions.use("storage", "", budget(), async () => {})
  await f.sessions.use("storage", "", budget(), async (_, _context, storage) => {
    expect(storage.get("https://example.com")).toEqual([["login", "fixture"]])
    expect(storage.has("https://other.example")).toBeFalse()
  })
  closed = false
  values = [["large", "x".repeat(5_000_001)]]
  await f.sessions.use("storage", "", budget(), async () => {})
  expect(await f.sessions.list()).toEqual([])
  expect(f.contexts[0].closed).toBeTrue()
  expect(f.retained()).toBe(0)
})

test("a deadline during page cleanup also retires the session", async () => {
  const f = fixture()
  await f.sessions.create({ id: "cleanup" })
  f.contexts[0].pages = () => [
    {
      frames: () => [],
      close: async () => {
        await Bun.sleep(30)
      },
    },
  ]
  await f.sessions.use("cleanup", "", budget(10), async () => {})
  expect(f.contexts[0].closed).toBeTrue()
  expect(await f.sessions.list()).toEqual([])
  expect(f.releases).toHaveLength(2)
})

test("named sessions respect Tier 4 and the crossed-landing guard without changing identity", async () => {
  const f = fixture()
  await f.sessions.create({ id: "tls", proxy: "http://proxy.example:8080", ignoreCertificateErrors: true })
  const deps = {
    ...f.deps,
    sessions: f.sessions,
    minTier: 4 as const,
    landingProbe: async () => "requested.example",
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  await expect(
    scrape({ url: "https://requested.example", sessionId: "tls" }, deps, {
      tier3: async () => {
        throw new Error("must honor deployment Tier 4 floor")
      },
      tier4: async (_url, _handle, _ms, proxy, _headers, _method, _body, _validator, _screenshot, capture) => {
        expect(proxy).toBe("http://proxy.example:8080")
        expect(capture?.sessionContext).toBe(f.contexts[0])
        return {
          tier: 4,
          status: "success",
          durationMs: 1,
          html: "<html>wrong page</html>",
          effectiveUrl: "https://unrelated.example",
        }
      },
    }),
  ).rejects.toThrow("crossed landing")
})

test("shutdown while a context is opening closes the late context and releases its retention", async () => {
  const f = fixture()
  const original = f.handle.browser.newContext
  let publish!: (context: unknown) => void
  let opening!: () => void
  const started = new Promise<void>((resolve) => {
    opening = resolve
  })
  f.handle.browser.newContext = async () => {
    opening()
    return new Promise((resolve) => {
      publish = resolve
    })
  }
  const creating = f.sessions.create({ id: "opening" })
  await started
  const shutdown = f.sessions.shutdown()
  const context = await original()
  publish(context)
  await shutdown
  await expect(creating).rejects.toMatchObject({ statusCode: 410 })
  expect(context.closed).toBeTrue()
  expect(f.retained()).toBe(0)
  expect(f.releases).toHaveLength(1)
})

describe("kept pages", () => {
  test("a kept page persists across operations while default sessions close theirs", async () => {
    const f = fixture()
    await f.sessions.create({ id: "kept", keepPage: true })
    expect(f.contexts[0].pageList).toHaveLength(1)
    const kept = f.contexts[0].pageList[0]
    for (let i = 0; i < 2; i++) {
      await f.sessions.use("kept", "", budget(), async (_handle, _context, _storage, page) => {
        expect(page as unknown).toBe(kept)
      })
    }
    expect(f.contexts[0].pages()).toHaveLength(1)
    expect(kept.closed).toBeFalse()
    expect(kept.frame.evaluateCalls).toBe(0)

    await f.sessions.create({ id: "plain" })
    let plainPage: KeptFakePage | undefined
    await f.sessions.use("plain", "", budget(), async (_handle, context) => {
      plainPage = (await context.newPage()) as unknown as KeptFakePage
    })
    expect(plainPage?.closed).toBeTrue()
    expect(plainPage?.frame.evaluateCalls).toBe(1)
    expect(f.contexts[1].pages()).toHaveLength(0)
  })

  test("evaluate runs expressions against the retained page and requires the opt-in", async () => {
    const f = fixture()
    await f.sessions.create({ id: "eval", keepPage: true })
    expect(await f.sessions.evaluate("eval", "window.answer", budget())).toBe(42)
    expect(f.contexts[0].pageList[0].evaluateCalls).toEqual(["mw:window.answer"])
    await f.sessions.create({ id: "plain" })
    await expect(f.sessions.evaluate("plain", "1", budget())).rejects.toMatchObject({ statusCode: 400 })
    await expect(f.sessions.evaluate("missing", "1", budget())).rejects.toMatchObject({ statusCode: 404 })
  })

  test("cookies reads the context jar without touching the page", async () => {
    const f = fixture()
    await f.sessions.create({ id: "web", keepPage: true })
    f.contexts[0].jar = [
      {
        name: "login",
        value: "yes",
        domain: ".fixture.example",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]
    expect(await f.sessions.cookies("web", budget())).toEqual([
      {
        name: "login",
        value: "yes",
        domain: ".fixture.example",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ])
    expect(f.contexts[0].pageList[0].evaluateCalls).toEqual([])
    await f.sessions.create({ id: "plain" })
    expect(await f.sessions.cookies("plain", budget())).toEqual([])
    await expect(f.sessions.cookies("missing", budget())).rejects.toMatchObject({ statusCode: 404 })
  })

  test("kept pages stay isolated between sessions", async () => {
    const f = fixture()
    await f.sessions.create({ id: "a", keepPage: true })
    await f.sessions.create({ id: "b", keepPage: true })
    expect(f.contexts[0].pageList[0]).not.toBe(f.contexts[1].pageList[0])
    f.contexts[0].jar = [{ name: "secret", value: "a", domain: ".fixture.example", path: "/", httpOnly: true }]
    expect((await f.sessions.cookies("a", budget())).map((cookie) => cookie.name)).toEqual(["secret"])
    expect(await f.sessions.cookies("b", budget())).toEqual([])
  })

  test("a busy kept-page session rejects eval and cookies", async () => {
    const f = fixture()
    await f.sessions.create({ id: "busy", keepPage: true })
    let release = () => {}
    const pending = f.sessions.use(
      "busy",
      "",
      budget(),
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await expect(f.sessions.evaluate("busy", "1", budget())).rejects.toMatchObject({ statusCode: 409 })
    await expect(f.sessions.cookies("busy", budget())).rejects.toMatchObject({ statusCode: 409 })
    release()
    await pending
  })

  test("destroy, expiry and timed-out operations close the retained page", async () => {
    let now = 1_000
    const f = fixture({ ttlMs: 100_000, now: () => now })
    await f.sessions.create({ id: "doomed", keepPage: true })
    await f.sessions.destroy("doomed")
    expect(f.contexts[0].closed).toBeTrue()
    expect(f.contexts[0].pageList[0].closed).toBeTrue()

    await f.sessions.create({ id: "stuck", keepPage: true })
    await expect(f.sessions.evaluate("stuck", "never-resolves", budget(100))).rejects.toThrow()
    expect(await f.sessions.list()).toEqual([])
    expect(f.contexts[1].closed).toBeTrue()
    expect(f.contexts[1].pageList[0].closed).toBeTrue()

    await f.sessions.create({ id: "short", keepPage: true })
    now = 1_000_000
    expect(await f.sessions.list()).toEqual([])
    expect(f.contexts[2].closed).toBeTrue()
    expect(f.contexts[2].pageList[0].closed).toBeTrue()
    await expect(f.sessions.evaluate("short", "1", budget())).rejects.toMatchObject({ statusCode: 404 })
  })
})
