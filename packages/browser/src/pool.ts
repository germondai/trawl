import type { BrowserHandle, PoolBrowser, PoolStats } from "@trawl/types"
import { Camoufox } from "camoufox-js"
import { FINGERPRINT_POOL } from "./fingerprint"
import { toPlaywrightProxy } from "./proxy"

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

type AsyncAction = () => unknown | Promise<unknown>

const settle = (action: AsyncAction): Promise<void> =>
  Promise.resolve()
    .then(action)
    .then(
      () => {},
      () => {},
    )

// Invoking the action inside the promise chain catches synchronous throws too.
const settleWithin = (action: AsyncAction | undefined, ms: number): Promise<void> => {
  if (!action) return Promise.resolve()
  const swallowed = settle(action)
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
  lease: number
  browser?: Browser
  context?: BrowserContext
  temporaryContextUses: number
  // Page closes started by release(); restartEntry lets them settle before tearing the
  // context down, so it isn't closing a context underneath in-flight page.close() calls.
  pendingPageCloses?: Promise<unknown>
  // Wall-clock instant past which this checkout is considered wedged. Set on acquire from
  // the caller's budget; undefined when idle.
  stallAt?: number
  restartReason?: string
  restarting?: boolean
  replacementRequested?: string
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
  private virtualDisplay: boolean
  private idOffset: number
  private label: string
  private stallAfterMs: number
  private closeTimeoutMs: number
  private launchTimeoutMs: number
  private healthIntervalMs: number
  private browserFactory?: BrowserFactory
  private healthInterval?: ReturnType<typeof setInterval>
  private abandonedLaunches = 0
  private maxAbandonedLaunches: number
  private replacementRunning = false
  private shuttingDown = false

  constructor({
    poolSize,
    acquireTimeoutMs = 15_000,
    pollIntervalMs = 100,
    recycleAfterTemporaryContexts = 8,
    contentProcesses = 2,
    virtualDisplay = false,
    idOffset = 0,
    label = "pool",
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
    virtualDisplay?: boolean
    // Keeps the browser ids of two pools in disjoint ranges, so a caller holding a handle
    // can route its release back to the pool that issued it.
    idOffset?: number
    label?: string
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
    this.virtualDisplay = virtualDisplay
    this.idOffset = idOffset
    this.label = label
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
    if (this.poolSize <= 0) return

    const launch = async (i: number) => {
      // Pick a fingerprint for this instance; the picked OS drives the browser's
      // navigator.platform, locale, timezone, and the HTTP UA the orchestrator sends.
      // Shuffled pool (not sequential) so 4 browsers don't all get the same fingerprint.
      const fingerprint = FINGERPRINT_POOL[i % FINGERPRINT_POOL.length]
      // Bounded like every other launch: an unbounded hang here leaves init() pending
      // forever with the HTTP listener already up, so the pod never becomes ready and
      // never fails either. Throwing lets the startup probe restart the container.
      const { browser, context } = await this.launchWithin(fingerprint, this.launchTimeoutMs)
      this.entries.push({
        id: this.idOffset + i,
        busy: false,
        lease: 0,
        restartCount: 0,
        healthy: true,
        browser,
        context,
        temporaryContextUses: 0,
        fingerprint,
      })
      console.log(`[${this.label}] browser ${i + 1}/${this.poolSize} ready (UA=${fingerprint.platform})`)
    }

    // Camoufox performs one-time shared addon setup during its first launch; racing
    // that setup can expose a half-extracted addon to sibling launches. Publish the
    // first browser immediately, then warm the remaining capacity concurrently.
    try {
      await launch(0)
    } catch (error) {
      await this.shutdown()
      throw error
    }

    const launches = Array.from({ length: Math.max(0, this.poolSize - 1) }, (_, i) => launch(i + 1))

    const results = await Promise.allSettled(launches)
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) {
      // Successful siblings were published progressively. Close them before
      // surfacing a failed startup so tests and supervised restarts do not leak.
      await this.shutdown()
      throw failure.reason
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
      // DataDome's Device Check scores headless signals directly, so a headless run fails it
      // however clean the fingerprint is. `"virtual"` gives Camoufox a real Xvfb display and
      // launches the browser headful behind it; camoufox-js kills the display on
      // browser.close(). Needs the Xvfb binary, hence the opt-in.
      headless: this.virtualDisplay ? "virtual" : true,
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
      // Camoufox 150.x managed-mode relies on `firefox_user_prefs` (Playwright
      // maps this to firefoxUserPrefs). The earlier `prefs` key was silently
      // ignored, so these settings were dead code in 1.0.0.
      firefox_user_prefs: {
        "dom.ipc.processCount": this.contentProcesses,
        "dom.ipc.processPrelaunch": false,
        "dom.ipc.contentProcessCount": this.contentProcesses,

        // Telemetry
        "datareporting.healthreport.uploadEnabled": false,
        "datareporting.policy.dataSubmissionEnabled": false,
        "datareporting.policy.dataSubmissionURL": "",
        "toolkit.telemetry.enabled": false,
        "toolkit.telemetry.unified": false,
        "toolkit.telemetry.archive": false,
        "toolkit.telemetry.updatePing.enabled": false,
        "app.crashreporter": false,
        "breakpad.reportURL": "",
        "breakpad.submitReportURL": "",

        // Disabled Firefox services — not used in headless scraping
        "browser.safebrowsing.downloads.enabled": false,
        "browser.safebrowsing.malware.enabled": false,
        "extensions.update.enabled": false,
        "extensions.systemAddon.update.url": "",
        "browser.fixup.alternate.enabled": false,
        "app.normandy.enabled": false,
        "app.shield.optoutstudies.enabled": false,
        "network.connectivity-service.enabled": false,
        "network.captive-portal-service.enabled": false,
        "network.prefetch-next": false,
        "beacon.enabled": false,
        "security.OCSP.enabled": 0,
        "network.http.tls-handshake-timeout": 30,
        "network.http.connection-timeout": 60,
        "network.http.response.timeout": 120,

        // UI chrome features a scraper never sees
        "extensions.screenshots.system.enabled": false,
        "extensions.screenshots.background.enabled": false,
        "browser.sessionstore.max_tabs_undo": 0,
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
        Object.defineProperty(this, "shadowRootUnl", { configurable: true, value: shadowRoot })
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
          noteTemporaryContext: ((lease: number) => () => {
            if (entry.lease !== lease) return
            this.noteTemporaryContext(entry)
          })(entry.lease),
          requestBrowserReplacement: ((lease: number) => (reason: string) => {
            if (entry.lease !== lease) return
            this.requestRollingReplacement(entry, reason)
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

  private pickEntry(domain?: string): PoolEntry | undefined {
    const available = this.entries.filter((e) => !e.busy && !e.restarting && e.healthy && e.context)
    if (available.length === 0) return
    if (domain) {
      const sticky = available.find((e) => e.lastDomain === domain)
      if (sticky) return sticky
    }
    return available[0]
  }

  private noteTemporaryContext(entry: PoolEntry): void {
    if (this.recycleAfterTemporaryContexts <= 0) return
    entry.temporaryContextUses++
    if (entry.temporaryContextUses >= this.recycleAfterTemporaryContexts) {
      this.requestRollingReplacement(entry, `${entry.temporaryContextUses} temporary contexts created`)
    }
  }

  private requestRollingReplacement(entry: PoolEntry, reason: string): void {
    if (entry.restarting) return
    entry.replacementRequested ??= reason
    if (!entry.busy) void this.runNextRollingReplacement()
  }

  // Periodic recycling is rolling: the existing browser remains usable while its
  // replacement starts. A pool-wide lock bounds the temporary peak to one browser.
  private async runNextRollingReplacement(): Promise<void> {
    if (this.replacementRunning || this.shuttingDown) return
    const entry = this.entries.find((candidate) => candidate.replacementRequested && !candidate.restarting)
    if (!entry) return
    this.replacementRunning = true
    const reason = entry.replacementRequested as string
    entry.replacementRequested = undefined
    console.warn(`[${this.label}] browser ${entry.id} warming replacement: ${reason}`)

    let replacement: { browser: Browser; context: BrowserContext } | undefined
    try {
      if (this.abandonedLaunches >= this.maxAbandonedLaunches) {
        throw new Error(`${this.abandonedLaunches} launches already abandoned; not starting another until one settles`)
      }
      replacement = await this.launchWithin(entry.fingerprint, this.launchTimeoutMs)

      // Acquires continue during the launch. Wait to swap until the current lease is
      // released, without marking the entry unavailable in the meantime.
      while (entry.busy && !this.shuttingDown) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      }
      if (this.shuttingDown) return

      const retiredBrowser = entry.browser
      const retiredContext = entry.context
      const pendingPageCloses = entry.pendingPageCloses
      entry.browser = replacement.browser
      entry.context = replacement.context
      replacement = undefined
      entry.pendingPageCloses = undefined
      entry.temporaryContextUses = 0
      // Contexts created while this replacement was warming belong to the browser
      // being retired. They may have re-asserted the threshold request, but the new
      // browser starts clean and must not immediately replace itself again.
      entry.replacementRequested = undefined
      entry.restartCount++
      entry.healthy = true
      entry.lease++
      console.log(`[${this.label}] browser ${entry.id} rolling replacement installed (total: ${entry.restartCount})`)

      await settleWithin(pendingPageCloses ? () => pendingPageCloses : undefined, this.closeTimeoutMs)
      await settleWithin(() => retiredContext?.close(), this.closeTimeoutMs)
      await settleWithin(() => retiredBrowser?.close(), this.closeTimeoutMs)
    } catch (err) {
      // A failed warm-up never disturbs the browser currently serving the entry.
      entry.replacementRequested ??= reason
      console.error(`[${this.label}] browser ${entry.id} failed to warm replacement:`, err)
    } finally {
      if (replacement) {
        await settleWithin(() => replacement?.context?.close(), this.closeTimeoutMs)
        await settleWithin(() => replacement?.browser?.close(), this.closeTimeoutMs)
      }
      this.replacementRunning = false
      // Do not spin immediately on a failed launch. Health checks and subsequent
      // releases provide bounded retry opportunities.
      const next = this.entries.find((candidate) => candidate.replacementRequested && candidate !== entry)
      if (next) void this.runNextRollingReplacement()
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
    let pages: { close: AsyncAction }[] = []
    try {
      pages = entry.context?.pages() ?? []
    } catch {}
    entry.pendingPageCloses = Promise.all(pages.map((page) => settle(() => page.close())))
    if (entry.restartReason) {
      const reason = entry.restartReason
      entry.restartReason = undefined
      // Called synchronously, not deferred behind the page closes: restartEntry sets
      // `restarting` before its first await, and that flag is what stops another request
      // acquiring this entry in the window before the browser is actually torn down.
      // restartEntry waits on pendingPageCloses itself.
      void this.restartEntry(entry, reason)
    } else if (entry.replacementRequested) {
      void this.runNextRollingReplacement()
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
          console.warn(`[${this.label}] browser ${entry.id} stalled — checked out for ${heldSec}s, reclaiming`)
          await this.restartEntry(entry, "checkout stalled")
        }
        continue
      }

      if (!(entry.browser?.isConnected() ?? false)) {
        console.warn(`[${this.label}] browser ${entry.id} disconnected, restarting`)
        await this.restartEntry(entry, "browser disconnected")
      } else {
        entry.healthy = true
        if (entry.replacementRequested) void this.runNextRollingReplacement()
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
    if (!result) {
      throw new Error(`browser launch exceeded ${ms}ms; check outbound network and GeoIP access`)
    }
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
    console.warn(`[${this.label}] browser ${entry.id} restarting: ${reason}`)
    const dyingContext = entry.context
    const dyingBrowser = entry.browser
    const pendingPageCloses = entry.pendingPageCloses
    delete entry.context
    delete entry.browser
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
    await settleWithin(pendingPageCloses ? () => pendingPageCloses : undefined, this.closeTimeoutMs)
    await settleWithin(() => dyingContext?.close(), this.closeTimeoutMs)
    await settleWithin(() => dyingBrowser?.close(), this.closeTimeoutMs)
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
      console.log(`[${this.label}] browser ${entry.id} restarted (total: ${entry.restartCount})`)
    } catch (err) {
      // Leave the entry unhealthy with no browser attached. `restarting` clears in the
      // finally, so the next health-check tick retries this entry from scratch.
      console.error(`[${this.label}] browser ${entry.id} failed to restart:`, err)
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
    this.shuttingDown = true
    if (this.healthInterval) {
      clearInterval(this.healthInterval)
      delete this.healthInterval
    }
    for (const entry of this.entries) {
      // Bounded for the same reason as restartEntry — an unbounded close here hangs
      // SIGTERM handling until the supervisor's grace period expires and force-kills us.
      await settleWithin(() => entry.context?.close(), this.closeTimeoutMs)
      await settleWithin(() => entry.browser?.close(), this.closeTimeoutMs)
    }
    this.entries = []
  }
}

// These preserve the caller's Playwright or Patchright types; the two libraries are
// structurally incompatible even though both expose the same runtime methods.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type FreshBrowser = any
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type FreshContext = any
export const newFreshContext = async (
  browser: FreshBrowser,
  options?: { proxy?: string; onCreated?: () => void; requestReplacement?: (reason: string) => void },
): Promise<FreshContext> => {
  const context = await browser.newContext({
    viewport: null,
    ...(options?.proxy ? { proxy: toPlaywrightProxy(options.proxy) } : {}),
  })
  options?.onCreated?.()
  try {
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
        Object.defineProperty(this, "shadowRootUnl", { configurable: true, value: r })
        return r
      }
    })
    return context
  } catch (err) {
    await closeTemporaryContext(
      context,
      options?.requestReplacement,
      "temporary context initialization cleanup timed out",
      CLOSE_TIMEOUT_MS,
    )
    throw err
  }
}

export const closeTemporaryContext = async (
  context: { close: AsyncAction } | undefined,
  requestReplacement?: (reason: string) => void,
  reason = "temporary context cleanup timed out",
  timeoutMs = 5_000,
): Promise<void> => {
  if (!context) return
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    settle(() => context.close()).then(() => {
      settled = true
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  if (!settled) requestReplacement?.(reason)
}
