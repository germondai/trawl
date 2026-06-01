import type { PoolBrowser, PoolStats } from "@trawl/types"
import { Camoufox } from "camoufox-js"

// camoufox-js returns playwright-core types at runtime but doesn't re-export them
// biome-ignore lint/suspicious/noExplicitAny: camoufox-js doesn't export Browser/BrowserContext types
type Browser = any
// biome-ignore lint/suspicious/noExplicitAny: camoufox-js doesn't export Browser/BrowserContext types
type BrowserContext = any

export class PoolExhaustedError extends Error {
  constructor() {
    super("Browser pool exhausted: all browsers are busy")
    this.name = "PoolExhaustedError"
  }
}

export interface BrowserHandle {
  id: number
  context: BrowserContext
  browser: Browser
}

interface PoolEntry extends PoolBrowser {
  browser: Browser | null
  context: BrowserContext | null
}

export class BrowserPool {
  private entries: PoolEntry[] = []
  private poolSize: number
  private healthInterval: ReturnType<typeof setInterval> | null = null

  constructor({ poolSize }: { poolSize: number }) {
    this.poolSize = poolSize
  }

  async init(): Promise<void> {
    for (let i = 0; i < this.poolSize; i++) {
      const { browser, context } = await this.launchBrowser()
      this.entries.push({ id: i, busy: false, restartCount: 0, healthy: true, browser, context })
      console.log(`[pool] browser ${i + 1}/${this.poolSize} ready`)
    }
  }

  private async launchBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    // Camoufox patches fingerprint data at the C++/Juggler level — not via JS injection.
    // CF's JS cannot detect these patches the way it detects overrides of window.chrome,
    // plugins, WebGL etc. Same browser Byparr uses.
    const browser = await Camoufox({
      headless: true,
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
      locale: "en-US",
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

  acquire(domain?: string): Promise<BrowserHandle> {
    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        const entry = this.pickEntry(domain)
        if (!entry) return false
        if (!entry.context || !entry.browser) return false
        entry.busy = true
        entry.lastDomain = domain
        entry.lastUsedAt = Date.now()
        resolve({ id: entry.id, context: entry.context, browser: entry.browser })
        return true
      }

      if (tryAcquire()) return

      const deadline = Date.now() + 5000
      const poll = setInterval(() => {
        if (tryAcquire()) {
          clearInterval(poll)
          return
        }
        if (Date.now() >= deadline) {
          clearInterval(poll)
          reject(new PoolExhaustedError())
        }
      }, 100)
    })
  }

  private pickEntry(domain?: string): PoolEntry | null {
    const available = this.entries.filter((e) => !e.busy && e.healthy && e.context)
    if (available.length === 0) return null
    if (domain) {
      const sticky = available.find((e) => e.lastDomain === domain)
      if (sticky) return sticky
    }
    return available[0]
  }

  release(id: number): void {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return
    entry.busy = false
    // Keep the context alive — CF cookies (cf_clearance, __cf_bm) and browser cache
    // accumulate, making subsequent challenges faster. Cookies are domain-scoped.
    if (entry.context) {
      const pages: unknown[] = entry.context.pages() ?? []
      for (const p of pages) (p as { close: () => Promise<void> }).close().catch(() => {})
    }
  }

  startHealthCheck(): void {
    this.healthInterval = setInterval(() => this.runHealthCheck(), 30_000)
  }

  private async runHealthCheck(): Promise<void> {
    for (const entry of this.entries) {
      if (entry.busy) continue
      if (!(entry.browser?.isConnected() ?? false)) {
        console.warn(`[pool] browser ${entry.id} disconnected, restarting`)
        await this.restartEntry(entry)
      } else {
        entry.healthy = true
      }
    }
  }

  private async restartEntry(entry: PoolEntry): Promise<void> {
    entry.healthy = false
    try {
      await entry.context?.close()
    } catch {}
    try {
      await entry.browser?.close()
    } catch {}
    entry.browser = null
    entry.context = null
    try {
      const { browser, context } = await this.launchBrowser()
      entry.browser = browser
      entry.context = context
      entry.healthy = true
      entry.restartCount++
      console.log(`[pool] browser ${entry.id} restarted (total: ${entry.restartCount})`)
    } catch (err) {
      console.error(`[pool] browser ${entry.id} failed to restart:`, err)
    }
  }

  getStats(): PoolStats {
    const busy = this.entries.filter((e) => e.busy).length
    const totalRestarts = this.entries.reduce((sum, e) => sum + e.restartCount, 0)
    return {
      total: this.poolSize,
      busy,
      available: this.poolSize - busy,
      restarts: totalRestarts,
      avgRestarts: totalRestarts / this.poolSize,
    }
  }

  async shutdown(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval)
    for (const entry of this.entries) {
      await entry.context?.close().catch(() => {})
      await entry.browser?.close().catch(() => {})
    }
    this.entries = []
  }
}

// Creates a fresh context from any browser with TRAWL init scripts applied.
// A fresh context (no prior cookies/localStorage/service workers) gets CF managed-mode
// treatment — challenge resolves in 3-4s vs ~40s for warm/reused contexts.
// biome-ignore lint/suspicious/noExplicitAny: camoufox-js doesn't export BrowserContext type
export const newFreshContext = async (browser: any): Promise<any> => {
  const context = await browser.newContext({ viewport: null })
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
