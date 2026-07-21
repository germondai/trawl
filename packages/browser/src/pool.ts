import type { BrowserHandle, PoolBrowser, PoolStats } from "@trawl/types"
import { Camoufox } from "camoufox-js"
import { FINGERPRINT_POOL } from "./fingerprint"

// camoufox-js wraps Playwright but doesn't re-export Browser/BrowserContext types.
// The pool accepts any structurally-compatible browser (Playwright OR patchright) —
// browsers exported from one aren't structurally assignable to the other in their
// own TypeScript types, so `any` is the pragmatic escape hatch here.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type Browser = any
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type BrowserContext = any

// Closing a Camoufox browser or context can hang indefinitely when a content process is
// wedged — tier3/tier4 already guard their temporary contexts this way. 10s is far above
// the typical sub-second close path.
const CLOSE_TIMEOUT_MS = 10_000
// A cold Camoufox start is a few seconds; camoufox-js also does a public-IP lookup for
// `geoip` before handing off to Playwright, which adds network time that Playwright's own
// launch timeout does not cover. 90s is generous but finite.
const LAUNCH_TIMEOUT_MS = 90_000

// Resolves when `p` settles or `ms` elapses, whichever comes first. Never rejects, and
// never leaves an unhandled rejection behind when `p` fails after we stopped waiting.
function settleWithin(p: Promise<unknown> | undefined | null, ms: number): Promise<void> {
  if (!p) return Promise.resolve()
  const swallowed = p.then(
    () => {},
    () => {},
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    swallowed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export class PoolExhaustedError extends Error {
  constructor() {
    super("Browser pool exhausted: all browsers are busy")
    this.name = "PoolExhaustedError"
  }
}

// BrowserHandle now lives in @trawl/types (shared cross-package); re-exported here
// for backward compat so existing `import type { BrowserHandle } from "@trawl/browser"` keeps working.
export type { BrowserHandle } from "@trawl/types"

interface PoolEntry extends PoolBrowser {
  // Monotonic per-checkout token. Bumped on every acquire and every restart so a
  // release() arriving from an abandoned request can be recognised and ignored.
  lease: number
  browser: Browser | null
  context: BrowserContext | null
  temporaryContextUses: number
  // Page closes started by release(); restartEntry lets them settle before tearing the
  // context down, so it isn't closing a context underneath in-flight page.close() calls.
  pendingPageCloses?: Promise<unknown>
  // Wall-clock instant past which this checkout is considered wedged. Set on acquire from
  // the caller's budget; undefined when idle.
  stallAt?: number
  restartReason?: string
  restarting?: boolean
  fingerprint: (typeof FINGERPRINT_POOL)[number]
}

type BrowserFactory = () => Promise<{ browser: Browser; context: BrowserContext }>

export class BrowserPool {
  private entries: PoolEntry[] = []
  private poolSize: number
  private acquireTimeoutMs: number
  private pollIntervalMs: number
  private recycleAfterTemporaryContexts: number
  private contentProcesses!: number
  private stallAfterMs: number
  private closeTimeoutMs: number
  private launchTimeoutMs: number
  private healthIntervalMs: number
  private browserFactory?: BrowserFactory
  private healthInterval: ReturnType<typeof setInterval> | null = null
  // Launch attempts we timed out on and can no longer cancel. Decremented if the attempt
  // ever settles. Retrying past maxAbandonedLaunches would just stack up more of them.
  private abandonedLaunches = 0
  private maxAbandonedLaunches: number

  constructor({
    poolSize,
    acquireTimeoutMs = 15_000,
    pollIntervalMs = 100,
    recycleAfterTemporaryContexts = 8,
    contentProcesses = 2,
    stallAfterMs = 180_000,
    closeTimeoutMs = CLOSE_TIMEOUT_MS,
    launchTimeoutMs = LAUNCH_TIMEOUT_MS,
    healthIntervalMs = 30_000,
    maxAbandonedLaunches = 3,
    browserFactory,
  }: {
    poolSize: number
    acquireTimeoutMs?: number
    pollIntervalMs?: number
    recycleAfterTemporaryContexts?: number
    contentProcesses?: number
    stallAfterMs?: number
    closeTimeoutMs?: number
    launchTimeoutMs?: number
    healthIntervalMs?: number
    maxAbandonedLaunches?: number
    browserFactory?: BrowserFactory
  }) {
    this.poolSize = poolSize
    this.acquireTimeoutMs = acquireTimeoutMs
    this.pollIntervalMs = pollIntervalMs
    this.recycleAfterTemporaryContexts = recycleAfterTemporaryContexts
    this.contentProcesses = contentProcesses
    this.stallAfterMs = stallAfterMs
    this.closeTimeoutMs = closeTimeoutMs
    this.launchTimeoutMs = launchTimeoutMs
    this.healthIntervalMs = healthIntervalMs
    this.maxAbandonedLaunches = maxAbandonedLaunches
    this.browserFactory = browserFactory
  }

  // A checkout past its deadline is not slow, it's wedged. The deadline is the caller's
  // own budget (req.maxTimeout) plus a full stallAfterMs of grace, so a request is never
  // reclaimed while it is still inside the time it asked for — callers may legitimately
  // pass a maxTimeout larger than stallAfterMs. Without a budget we fall back to
  // stallAfterMs alone.
  private isStalled(entry: PoolEntry, now = Date.now()): boolean {
    if (!entry.busy || entry.stallAt === undefined) return false
    return now > entry.stallAt
  }

  async init(): Promise<void> {
    for (let i = 0; i < this.poolSize; i++) {
      // Pick a fingerprint for this instance; the picked OS drives the browser's
      // navigator.platform, locale, timezone, and the HTTP UA the orchestrator sends.
      // Shuffled pool (not sequential) so 4 browsers don't all get the same fingerprint.
      const fingerprint = FINGERPRINT_POOL[i % FINGERPRINT_POOL.length]
      // Bounded like every other launch: an unbounded hang here leaves init() pending
      // forever with the HTTP listener already up, so the pod never becomes ready and
      // never fails either. Throwing lets the startup probe restart the container.
      const { browser, context } = await this.launchWithin(fingerprint, this.launchTimeoutMs)
      this.entries.push({
        id: i,
        busy: false,
        lease: 0,
        restartCount: 0,
        healthy: true,
        browser,
        context,
        temporaryContextUses: 0,
        fingerprint,
      })
      console.log(`[pool] browser ${i + 1}/${this.poolSize} ready (UA=${fingerprint.platform})`)
    }
  }

  private async launchBrowser(
    fingerprint: (typeof FINGERPRINT_POOL)[number],
  ): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.browserFactory) return this.browserFactory()

    // Map our platform token → Camoufox's `os` token.
    const camoufoxOs =
      fingerprint.platform === "Win32" ? "windows" : fingerprint.platform === "MacIntel" ? "macos" : "linux"

    // Camoufox patches fingerprint data at the C++/Juggler level — not via JS injection.
    // CF's JS cannot detect these patches the way it detects overrides of window.chrome,
    // plugins, WebGL etc. Same browser Byparr uses.
    //
    // Anti-detection levers we use (in addition to Camoufox's defaults):
    //   `os`             — random pick per browser: {windows, macos, linux}. Each browser
    //                     in the pool looks like a different OS to fingerprinters, so
    //                     cross-browser session correlation becomes harder.
    //   `screen`         — randomize resolution per browser within realistic bounds.
    //   `window`         — randomize window size per browser.
    //   `humanize`       — randomized mouse movement + timing patterns.
    //   `geoip`          — auto-derive timezone/locale from the server's IP.
    //   `block_webrtc`   — no IP leak via WebRTC.
    //   `disable_coop`   — keep cross-origin iframe interactivity (and avoid
    //                     crossOriginIsolated being false-detectable).
    //   `main_world_eval` — required for Turnstile's shadow-DOM checkbox.
    //   `forceScopeAccess` — C++-level cross-origin frame scope, COOP-friendly.
    const browser = await Camoufox({
      headless: true,
      os: [camoufoxOs],
      // Screen + window randomization — Camoufox picks from the constraints per launch.
      // `screen` lets us set min/max bounds; `window` is a single fixed tuple per type
      // so we pick one realistic value here. The fingerprint will still differ across
      // browsers because of `os` + `screen` randomization + Camoufox's per-launch
      // randomization (canvas seed, audio seed, font list, etc).
      screen: { minWidth: 1280, maxWidth: 2560, minHeight: 720, maxHeight: 1440 },
      window: [1920, 1080] as [number, number],
      geoip: true,
      humanize: true,
      disable_coop: true,
      block_webrtc: true,
      i_know_what_im_doing: true,
      // main_world_eval: needed so evaluate_handle calls can reach Turnstile's shadow-DOM checkbox
      main_world_eval: true,
      // forceScopeAccess: C++-level patch granting cross-origin frame scope without disabling
      // COOP at the prefs level (which CF detects via window.crossOriginIsolated)
      config: { forceScopeAccess: true },
      // Locale matches the picked fingerprint so navigator.language + HTTP Accept-Language
      // + browser-side Intl locale all align.
      locale: fingerprint.locale,
      timezone: fingerprint.timezone,
      // Cap content processes per browser. Firefox's default (8) lets thread count climb
      // when Tier 3/Tier 4 churn contexts (see #13). Lower cap → bounded OS footprint.
      // `processPrelaunch: false` stops Firefox from pre-warming extra processes eagerly.
      prefs: {
        "dom.ipc.processCount": this.contentProcesses,
        "dom.ipc.processPrelaunch": false,
      },
    })

    const context = await this.createContext(browser)
    return { browser, context }
  }

  private async createContext(browser: Browser): Promise<BrowserContext> {
    // viewport: null — Camoufox controls viewport via fingerprint config.
    // Passing Playwright's default viewport causes a Firefox protocol error on 'isMobile'.
    const context = await browser.newContext({ viewport: null })

    await context.addInitScript(() => {
      // Suppress uncaught JS errors so Firefox's error reporter doesn't crash Playwright
      // on anonymous async functions from CF challenge scripts
      window.onerror = () => true
      window.addEventListener(
        "unhandledrejection",
        (e) => {
          e.preventDefault()
        },
        true,
      )

      // Expose shadow roots via element.shadowRootUnl so we can traverse into Turnstile's
      // shadow DOM to click the actual checkbox — same technique Byparr uses
      const _attachShadow = Element.prototype.attachShadow
      Element.prototype.attachShadow = function (init: ShadowRootInit) {
        const shadowRoot = _attachShadow.call(this, init)
        // biome-ignore lint/suspicious/noExplicitAny: extending DOM element with custom property
        ;(this as any).shadowRootUnl = shadowRoot
        return shadowRoot
      }
    })

    return context
  }

  // `budgetMs` is the caller's own deadline for this checkout (the orchestrator passes
  // req.maxTimeout). It only ever extends how long the checkout is tolerated, never
  // shortens it below stallAfterMs.
  acquire(domain?: string, budgetMs?: number): Promise<BrowserHandle> {
    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        const entry = this.pickEntry(domain)
        if (!entry) return false
        if (!entry.context || !entry.browser) return false
        const now = Date.now()
        entry.busy = true
        entry.busySince = now
        entry.stallAt = now + Math.max(budgetMs ?? 0, 0) + this.stallAfterMs
        entry.lease++
        entry.lastDomain = domain
        entry.lastUsedAt = Date.now()
        resolve({
          id: entry.id,
          lease: entry.lease,
          context: entry.context,
          browser: entry.browser,
          fingerprint: entry.fingerprint,
          // Captured lease: a reclaimed request that resumes later must not attribute its
          // failure to the replacement browser now occupying this entry.
          noteTemporaryContext: ((lease: number) => (reason: string) => {
            if (entry.lease !== lease) return
            this.noteTemporaryContext(entry, reason)
          })(entry.lease),
        })
        return true
      }

      if (tryAcquire()) return

      const deadline = Date.now() + this.acquireTimeoutMs
      const poll = setInterval(() => {
        if (tryAcquire()) {
          clearInterval(poll)
          return
        }
        if (Date.now() >= deadline) {
          clearInterval(poll)
          reject(new PoolExhaustedError())
        }
      }, this.pollIntervalMs)
    })
  }

  private pickEntry(domain?: string): PoolEntry | null {
    const available = this.entries.filter((e) => !e.busy && !e.restarting && e.healthy && e.context)
    if (available.length === 0) return null
    if (domain) {
      const sticky = available.find((e) => e.lastDomain === domain)
      if (sticky) return sticky
    }
    return available[0]
  }

  private noteTemporaryContext(entry: PoolEntry, reason: string): void {
    if (this.recycleAfterTemporaryContexts <= 0) return
    // Skip if the entry is already being recycled — avoids incrementing the counter
    // against a dead entry and racing with the in-flight restartEntry.
    if (entry.restarting) return

    entry.temporaryContextUses++
    if (entry.temporaryContextUses >= this.recycleAfterTemporaryContexts) {
      entry.restartReason = `${reason}; ${entry.temporaryContextUses} temporary contexts used`
    }
  }

  release(id: number, lease?: number): void {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return
    // A checkout the health check already reclaimed must not free the entry a second
    // time — by now it may be restarting, or handed to a different request. The lease
    // identifies *which* checkout is being released; a mismatch means this one is stale.
    if (lease !== undefined && entry.lease !== lease) return
    if (!entry.busy) return
    entry.busy = false
    entry.busySince = undefined
    entry.stallAt = undefined
    // Keep the context alive — CF cookies (cf_clearance, __cf_bm) and browser cache
    // accumulate, making subsequent challenges faster. Cookies are domain-scoped.
    const pages: unknown[] = entry.context?.pages() ?? []
    entry.pendingPageCloses = Promise.all(
      pages.map((p) => (p as { close: () => Promise<void> }).close().catch(() => {})),
    )
    if (entry.restartReason) {
      const reason = entry.restartReason
      entry.restartReason = undefined
      // Called synchronously, not deferred behind the page closes: restartEntry sets
      // `restarting` before its first await, and that flag is what stops another request
      // acquiring this entry in the window before the browser is actually torn down.
      // restartEntry waits on pendingPageCloses itself.
      void this.restartEntry(entry, reason)
    }
  }

  startHealthCheck(): void {
    this.healthInterval = setInterval(() => this.runHealthCheck(), this.healthIntervalMs)
  }

  private async runHealthCheck(): Promise<void> {
    const now = Date.now()
    for (const entry of this.entries) {
      // A restart already in flight will finish or fail on its own deadline. Re-entering
      // here only produced the "disconnected, restarting" log every 30s that made a dead
      // pool look like a busy one.
      if (entry.restarting) continue

      if (entry.busy) {
        // We can't probe a checked-out browser — closing it would kill a live request.
        // But a checkout past the stall threshold is not a request any more: it never
        // reached the orchestrator's `finally`, so nothing will ever release it. Left
        // alone, the entry is subtracted from the pool for the rest of the process.
        if (this.isStalled(entry, now)) {
          const heldSec = Math.round((now - (entry.busySince ?? now)) / 1000)
          console.warn(`[pool] browser ${entry.id} stalled — checked out for ${heldSec}s, reclaiming`)
          await this.restartEntry(entry, "checkout stalled")
        }
        continue
      }

      if (!(entry.browser?.isConnected() ?? false)) {
        console.warn(`[pool] browser ${entry.id} disconnected, restarting`)
        await this.restartEntry(entry, "browser disconnected")
      } else {
        entry.healthy = true
      }
    }
  }

  // Runs `launchBrowser` under a hard deadline. Playwright's own launch timeout does not
  // cover camoufox-js's pre-launch work (the `geoip` public-IP lookup), so a launch can
  // outlive it; and an unbounded launch here is unrecoverable — see restartEntry.
  private async launchWithin(
    fingerprint: (typeof FINGERPRINT_POOL)[number],
    ms: number,
  ): Promise<{ browser: Browser; context: BrowserContext }> {
    let timedOut = false
    // Playwright exposes no way to cancel an in-flight launch, so a timeout here can only
    // stop *waiting* — the attempt keeps running. Count the ones we abandon so a browser
    // that hangs on every launch can't have attempts piled on it forever.
    this.abandonedLaunches++
    const launch = this.launchBrowser(fingerprint).then(
      (result) => {
        if (!timedOut) {
          this.abandonedLaunches--
          return result
        }
        // We already gave up on this launch — don't leak the browser it finally produced.
        // Stay charged until that close *actually* settles, with no timeout: releasing the
        // slot on a bound would let genuinely unkillable Firefox processes accumulate
        // silently, one per retry. Holding it means a doubly-wedged entry (launch hung,
        // then close hung) stays down and the pool reports reduced `live` — the readiness
        // gate surfaces that, which is the outcome we want over a quiet process leak.
        void Promise.resolve(result.browser?.close()).then(
          () => {
            this.abandonedLaunches--
          },
          () => {
            this.abandonedLaunches--
          },
        )
        return null
      },
      (err) => {
        this.abandonedLaunches--
        if (timedOut) return null
        throw err
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      launch,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve(null)
        }, ms)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    if (!result) throw new Error(`browser launch exceeded ${ms}ms`)
    return result
  }

  private async restartEntry(entry: PoolEntry, reason = "manual restart"): Promise<void> {
    if (entry.restarting) {
      entry.restartReason ??= reason
      return
    }
    entry.restarting = true
    entry.healthy = false
    // Drop any checkout this entry was holding. Either release() already cleared it, or
    // we are reclaiming a stalled one — in both cases the entry is ours now, and the
    // bumped lease makes a late release() from the abandoned request a no-op.
    entry.busy = false
    entry.busySince = undefined
    entry.stallAt = undefined
    entry.lease++
    entry.restartReason = undefined
    console.warn(`[pool] browser ${entry.id} restarting: ${reason}`)

    const dyingContext = entry.context
    const dyingBrowser = entry.browser
    const pendingPageCloses = entry.pendingPageCloses
    entry.context = null
    entry.browser = null
    entry.pendingPageCloses = undefined

    // Every await below is bounded, and that is the whole point. Camoufox/Firefox hangs
    // on close when a content process is wedged (the hazard tier3/tier4 already guard
    // their temporary contexts against), and camoufox-js's launch path can hang too. An
    // unbounded await anywhere in here strands the entry with restarting=true forever:
    // it is then excluded from `available` in getStats() and short-circuited by the
    // `if (entry.restarting)` guard at the top, so the 30s health check can only log
    // "disconnected, restarting" about it, never actually restart it. That is how a pool
    // reaches zero live browsers while its restart counter sits frozen and the process
    // looks perfectly healthy from the outside.
    await settleWithin(pendingPageCloses, this.closeTimeoutMs)
    await settleWithin(dyingContext?.close(), this.closeTimeoutMs)
    await settleWithin(dyingBrowser?.close(), this.closeTimeoutMs)

    try {
      // Refuse to pile another attempt onto a backlog of launches we already gave up
      // waiting for — each one may still be holding a real Firefox process we can't
      // cancel. The entry stays unhealthy, so `live` drops and the readiness gate takes
      // the pod out of rotation instead of quietly leaking processes.
      if (this.abandonedLaunches >= this.maxAbandonedLaunches) {
        throw new Error(`${this.abandonedLaunches} launches already abandoned; not starting another until one settles`)
      }
      // On restart, keep the entry's original fingerprint so this browser instance
      // keeps its identity across restart cycles (otherwise cross-session correlation
      // becomes trivial).
      const { browser, context } = await this.launchWithin(entry.fingerprint, this.launchTimeoutMs)
      entry.browser = browser
      entry.context = context
      entry.healthy = true
      entry.temporaryContextUses = 0
      entry.restartCount++
      console.log(`[pool] browser ${entry.id} restarted (total: ${entry.restartCount})`)
    } catch (err) {
      // Leave the entry unhealthy with no browser attached. `restarting` clears in the
      // finally, so the next health-check tick retries this entry from scratch.
      console.error(`[pool] browser ${entry.id} failed to restart:`, err)
    } finally {
      entry.restarting = false
    }
  }

  // A browser only counts if its transport is actually up. `healthy` is only refreshed
  // every health-check tick, and busy entries are never probed at all, so without this a
  // checkout whose browser died reads as capacity until its stall deadline passes.
  private isUsable(entry: PoolEntry): boolean {
    return Boolean(entry.context) && Boolean(entry.browser?.isConnected?.() ?? false)
  }

  getStats(): PoolStats {
    const now = Date.now()
    const busy = this.entries.filter((e) => e.busy).length
    const available = this.entries.filter((e) => !e.busy && !e.restarting && e.healthy && this.isUsable(e)).length
    const stalled = this.entries.filter((e) => this.isStalled(e, now)).length
    // Busy entries that are still genuinely working: inside their deadline AND connected.
    const busyLive = this.entries.filter((e) => e.busy && !this.isStalled(e, now) && this.isUsable(e)).length
    const totalRestarts = this.entries.reduce((sum, e) => sum + e.restartCount, 0)
    return {
      total: this.poolSize,
      busy,
      available,
      restarts: totalRestarts,
      avgRestarts: totalRestarts / this.poolSize,
      stalled,
      // Real capacity: idle-and-connected plus in-flight-and-connected. Excludes
      // restarting entries, wedged checkouts, and checkouts whose browser has died.
      live: available + busyLive,
    }
  }

  async shutdown(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval)
    for (const entry of this.entries) {
      // Bounded for the same reason as restartEntry — an unbounded close here hangs
      // SIGTERM handling until the supervisor's grace period expires and force-kills us.
      await settleWithin(entry.context?.close(), this.closeTimeoutMs)
      await settleWithin(entry.browser?.close(), this.closeTimeoutMs)
    }
    this.entries = []
  }
}

// Creates a fresh context from any browser with TRAWL init scripts applied.
// A fresh context (no prior cookies/localStorage/service workers) gets CF managed-mode
// treatment — challenge resolves in 3-4s vs ~40s for warm/reused contexts.
// biome-ignore lint/suspicious/noExplicitAny: camoufox-js doesn't export BrowserContext type
export const newFreshContext = async (browser: any, options?: { proxy?: string }): Promise<any> => {
  const context = await browser.newContext({
    viewport: null,
    ...(options?.proxy ? { proxy: { server: options.proxy } } : {}),
  })
  await context.addInitScript(() => {
    window.onerror = () => true
    window.addEventListener(
      "unhandledrejection",
      (e: PromiseRejectionEvent) => {
        e.preventDefault()
      },
      true,
    )
    const _orig = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const r = _orig.call(this, init)
      // biome-ignore lint/suspicious/noExplicitAny: extending DOM element with custom property
      ;(this as any).shadowRootUnl = r
      return r
    }
  })
  return context
}
