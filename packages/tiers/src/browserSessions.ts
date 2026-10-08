import { type BrowserHandle, closeTemporaryContext, newFreshContext } from "@trawl/browser"
import type { BrowserSession, CreateBrowserSession } from "@trawl/types"
import type { AcquireOptions } from "./orchestrator"
import { RequestBudget } from "./utils/deadline"
import { RequestValidationError } from "./utils/sanitize"

type Context = Awaited<ReturnType<typeof newFreshContext>>
interface Entry {
  info: BrowserSession
  options: CreateBrowserSession
  context?: Context
  browser?: BrowserHandle["browser"]
  browserId?: number
  busy: boolean
  releaseRetention?: () => void
  requestReplacement?: (reason: string) => void
  closing?: Promise<void>
  opening?: Promise<Context>
  sessionStorage: Map<string, [string, string][]>
}
interface Options {
  acquireBrowser(domain: string, budgetMs: number, options: AcquireOptions): Promise<BrowserHandle>
  releaseBrowser(handle: BrowserHandle): void
  maxSessions?: number
  ttlMs?: number
  now?: () => number
  defaultProxy?: (id: string) => string | undefined
  requireProxy?: boolean
  trustedProxyCa?: (proxy: string) => Promise<string | undefined>
}

export function validateSessionId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new RequestValidationError("session ID must contain 1-128 letters, numbers, underscores or hyphens", 400)
  }
}

// Contexts are owned by this process. Redis clearance cookies cannot preserve
// localStorage, browser identity or a running context across a restart.
export class BrowserSessions {
  private readonly closing = new Set<Entry>()
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number
  private readonly maxSessions: number
  private readonly ttlMs: number
  private timer?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(private readonly deps: Options) {
    this.now = deps.now ?? Date.now
    this.maxSessions = deps.maxSessions ?? 4
    this.ttlMs = deps.ttlMs ?? 3_600_000
    if (
      !Number.isSafeInteger(this.maxSessions) ||
      this.maxSessions < 1 ||
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 1
    )
      throw new Error("Browser session capacity and TTL must be positive integers")
  }

  async create(options: CreateBrowserSession = {}, reuseExisting = false): Promise<BrowserSession> {
    if (this.stopped) throw new RequestValidationError("Session manager is shutting down", 503)
    const id = options.id ?? crypto.randomUUID()
    validateSessionId(id)
    if (reuseExisting) {
      await this.sweep()
      const existing = this.entries.get(id)
      if (existing) return this.info(existing)
    }
    const proxy = options.proxy ?? this.deps.defaultProxy?.(id)
    if (proxy !== undefined) {
      try {
        const url = new URL(proxy)
        if (!["http:", "https:", "socks5:"].includes(url.protocol) || !url.hostname) throw new Error()
      } catch {
        throw new RequestValidationError("Session proxy must be a valid HTTP, HTTPS or SOCKS5 URL", 400)
      }
    }
    if (this.deps.requireProxy && !proxy)
      throw new RequestValidationError("Minimum tier 4 requires a session proxy", 400)
    await this.sweep()
    if (this.stopped) throw new RequestValidationError("Session manager is shutting down", 503)
    const existing = this.entries.get(id)
    if (existing) {
      if (reuseExisting) return this.info(existing)
      throw new RequestValidationError("Session already exists", 409)
    }
    if ([...this.closing].some((entry) => entry.info.id === id))
      throw new RequestValidationError("Session is closing; retry after cleanup completes", 409)
    if (this.entries.size + this.closing.size >= this.maxSessions)
      throw new RequestValidationError("Browser session limit reached", 429)
    const now = this.now()
    const entry: Entry = {
      info: { id, createdAt: now, expiresAt: now + this.ttlMs, busy: false },
      options: { ...options, proxy },
      busy: false,
      sessionStorage: new Map(),
    }
    this.entries.set(id, entry)
    if (!this.timer) {
      this.timer = setInterval(
        () => {
          void this.sweep()
        },
        Math.min(this.ttlMs, 30_000),
      )
      this.timer.unref?.()
    }
    const budget = new RequestBudget(30_000)
    try {
      await this.use(id, "", budget, async () => {})
      return this.info(entry)
    } catch (error) {
      await this.remove(entry)
      throw error
    } finally {
      budget.dispose()
    }
  }

  async list(): Promise<BrowserSession[]> {
    await this.sweep()
    return [...this.entries.values()].map((entry) => this.info(entry))
  }

  async ensure(id: string, maxAgeMs?: number): Promise<BrowserSession> {
    validateSessionId(id)
    if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0))
      throw new RequestValidationError("Session maximum age must be positive", 400)
    await this.sweep()
    const entry = this.entries.get(id)
    if (entry && maxAgeMs !== undefined && this.now() - entry.info.createdAt > maxAgeMs) {
      const options = { ...entry.options }
      await this.destroy(id)
      return this.create({ ...options, id }, true)
    }
    return entry ? this.info(entry) : this.create({ id }, true)
  }

  options(id: string): Readonly<CreateBrowserSession> {
    return { ...this.require(id).options }
  }

  async destroy(id: string): Promise<void> {
    const entry = this.require(id)
    if (entry.busy) throw new RequestValidationError("Session is busy; retry after its request completes", 409)
    await this.remove(entry)
  }

  async use<T>(
    id: string,
    domain: string,
    budget: RequestBudget,
    operation: (handle: BrowserHandle, context: Context, storage: Map<string, [string, string][]>) => Promise<T>,
  ): Promise<T> {
    const entry = this.require(id)
    if (entry.busy) throw new RequestValidationError("Session is busy; retry after its request completes", 409)
    entry.busy = true
    let handle: BrowserHandle | undefined
    let opening: Promise<Context> | undefined
    try {
      const acquired = await budget.run<BrowserHandle>(() =>
        this.deps
          .acquireBrowser(domain, budget.remaining(), {
            signal: budget.signal,
            headful: entry.options.headful,
            browserId: entry.browserId,
          })
          .then((acquired) => {
            if (budget.signal.aborted) {
              this.deps.releaseBrowser(acquired)
              budget.check()
            }
            return acquired
          }),
      )
      handle = acquired
      budget.check()
      if (this.stopped || this.entries.get(id) !== entry)
        throw new RequestValidationError("Session is no longer available", 410)
      if (entry.browser && entry.browser !== handle.browser) {
        throw new RequestValidationError("Session browser was replaced; create a new session", 410)
      }
      if (!entry.context) {
        entry.releaseRetention = handle.retainBrowser?.()
        entry.requestReplacement = handle.requestBrowserReplacement
        const proxy = entry.options.proxy
        const trustedCa = proxy ? await budget.run(async () => this.deps.trustedProxyCa?.(proxy)) : undefined
        const pendingContext = newFreshContext(handle.browser, {
          proxy: entry.options.proxy,
          ignoreHttpsErrors: entry.options.ignoreCertificateErrors || Boolean(trustedCa),
          requestReplacement: handle.requestBrowserReplacement,
        })
        opening = pendingContext
        entry.opening = pendingContext
        entry.context = await budget.run(() => pendingContext)
        entry.browser = handle.browser
        entry.browserId = handle.id
        entry.context.once?.("close", () => {
          if (this.entries.get(id) === entry) this.entries.delete(id)
          entry.releaseRetention?.()
        })
      }
      if (this.stopped || this.entries.get(id) !== entry)
        throw new RequestValidationError("Session is no longer available", 410)
      const context = entry.context
      return await budget.run(() => operation(acquired, context, entry.sessionStorage))
    } catch (error) {
      // A timed out operation can still be mutating storage. Retire its context
      // before releasing the lease; never reuse an uncertain session.
      if (
        budget.signal.aborted ||
        this.stopped ||
        this.entries.get(id) !== entry ||
        !entry.context ||
        (handle && entry.browser !== handle.browser)
      ) {
        await this.remove(entry, handle, opening)
      }
      throw error
    } finally {
      const context = entry.context
      if (context && this.entries.get(id) === entry) {
        let cleanupFailed = false
        await closeTemporaryContext(
          {
            close: async () => {
              try {
                const page = context.pages()[0]
                if (page) {
                  for (const frame of page.frames()) {
                    const snapshot = await frame.evaluate(() => {
                      if (!/^https?:$/.test(location.protocol)) return null
                      try {
                        return { origin: location.origin, values: Object.entries(sessionStorage) }
                      } catch (error) {
                        if (error instanceof DOMException && error.name === "SecurityError") return null
                        throw error
                      }
                    })
                    if (snapshot) entry.sessionStorage.set(snapshot.origin, snapshot.values)
                  }
                  const chars = [...entry.sessionStorage].reduce(
                    (total, [origin, values]) =>
                      total + origin.length + values.reduce((n, [key, value]) => n + key.length + value.length, 0),
                    0,
                  )
                  if (entry.sessionStorage.size > 32 || chars > 5_000_000) cleanupFailed = true
                }
                await Promise.all(context.pages().map((page: { close(): Promise<void> }) => page.close()))
                if (context.pages().length) cleanupFailed = true
              } catch {
                cleanupFailed = true
              }
            },
          },
          () => {
            cleanupFailed = true
          },
          "session page cleanup timed out",
        )
        if (cleanupFailed) await this.remove(entry, handle)
      }
      if (budget.signal.aborted && this.entries.get(id) === entry) await this.remove(entry, handle)
      entry.busy = false
      entry.info.expiresAt = this.now() + this.ttlMs
      if (handle) this.deps.releaseBrowser(handle)
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await Promise.all([...this.entries.values(), ...this.closing].map((entry) => this.remove(entry)))
  }

  private info(entry: Entry): BrowserSession {
    return { ...entry.info, busy: entry.busy }
  }

  private require(id: string): Entry {
    validateSessionId(id)
    const entry = this.entries.get(id)
    if (!entry) throw new RequestValidationError("Session not found; create a new session", 404)
    if (!entry.busy && this.now() >= entry.info.expiresAt) {
      void this.remove(entry)
      throw new RequestValidationError("Session expired; create a new session", 404)
    }
    return entry
  }

  private async remove(entry: Entry, handle?: BrowserHandle, opening?: Promise<Context>): Promise<void> {
    if (this.entries.get(entry.info.id) === entry) this.entries.delete(entry.info.id)
    if (entry.closing) return entry.closing
    entry.sessionStorage.clear()
    this.closing.add(entry)
    const target = opening ?? entry.opening ?? entry.context
    const replacement = handle?.requestBrowserReplacement ?? entry.requestReplacement
    const resource = target
      ? Promise.resolve(target).then((context) => ({
          close: async () => {
            try {
              await context.close()
            } catch {
              replacement?.("session context cleanup failed")
            }
          },
        }))
      : undefined
    entry.closing = closeTemporaryContext(resource, replacement, "session context cleanup timed out").finally(() => {
      entry.releaseRetention?.()
      this.closing.delete(entry)
    })
    await entry.closing
  }

  private async sweep(): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => !entry.busy && this.now() >= entry.info.expiresAt)
        .map((entry) => this.remove(entry)),
    )
  }
}
