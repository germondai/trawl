import type { OrchestratorDeps } from "@trawl/tiers"
import type { BrowserObservationSnapshot, ObservedBrowserPage } from "@trawl/types"

type Page = Parameters<NonNullable<OrchestratorDeps["observePage"]>>[0]

export const browserPreviewLimits = Object.freeze({
  width: 1280,
  height: 720,
  maxBytes: 1048576,
  intervalMs: 1000,
  timeoutMs: 350,
})
export interface PageOwner {
  requestId?: string
  sessionId?: string
  source?: ObservedBrowserPage["source"]
  tier?: ObservedBrowserPage["tier"]
  browserId: number
  headful: boolean
  remaining?: () => number
  busy?: () => boolean
}
interface Entry {
  id: string
  page: Page
  owners: Map<object, PageOwner>
  revision: number
  lastStarted: number
  close: () => void
  navigate: () => void
}
interface Frame {
  bytes: Uint8Array
  revision: number
  at: number
}
export class BrowserObservationError extends Error {
  constructor(
    readonly status: 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** Owns bounded references to existing pages; observation never acquires, navigates or closes a browser. */
export class BrowserObservations {
  private entries = new Map<string, Entry>()
  private pages = new WeakMap<Page, Entry>()
  private frames = new Map<string, Frame>()
  private starts: number[] = []
  private inFlight = 0
  private capturing = new Set<string>()
  private omitted = 0
  private closed = false
  constructor(
    private readonly now = Date.now,
    private readonly platform = process.platform,
  ) {}

  register(page: Page, owner: PageOwner): () => void {
    if (this.closed) return () => {}
    let entry = this.pages.get(page)
    if ((!entry && this.entries.size >= 128) || (entry && entry.owners.size >= 4)) {
      this.omitted++
      let released = false
      return () => {
        if (!released) {
          released = true
          this.omitted--
        }
      }
    }
    if (!entry) {
      const id = crypto.randomUUID()
      entry = {
        id,
        page,
        owners: new Map(),
        revision: 0,
        lastStarted: -Infinity,
        close: () => this.remove(id),
        navigate: () => {
          const active = this.entries.get(id)
          if (active) {
            active.revision++
            this.frames.delete(id)
          }
        },
      }
      this.entries.set(id, entry)
      this.pages.set(page, entry)
      try {
        page.on("close", entry.close)
        page.on("framenavigated", entry.navigate)
      } catch {
        this.remove(id)
        return () => {}
      }
    }
    const token = {}
    entry.owners.set(token, owner)
    entry.revision++
    this.frames.delete(entry.id)
    const current = entry
    let released = false
    return () => {
      if (released) return
      released = true
      current.owners.delete(token)
      current.revision++
      this.frames.delete(current.id)
      if (!current.owners.size) this.remove(current.id)
    }
  }
  private remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.pages.delete(entry.page)
    this.frames.delete(id)
    try {
      entry.page.off("close", entry.close)
      entry.page.off("framenavigated", entry.navigate)
    } catch {}
  }
  private current(id: string) {
    const entry = this.entries.get(id)
    if (!entry || this.closed) throw new BrowserObservationError(404, "Browser page is no longer available")
    try {
      if (entry.page.isClosed()) {
        this.remove(id)
        throw new Error()
      }
    } catch {
      throw new BrowserObservationError(404, "Browser page is no longer available")
    }
    const owner = [...entry.owners.values()].at(-1)
    if (!owner) throw new BrowserObservationError(404, "Browser page is no longer available")
    return { entry, owner }
  }
  snapshot(headedConfigured = false): BrowserObservationSnapshot {
    const result: ObservedBrowserPage[] = []
    for (const id of this.entries.keys()) {
      try {
        const { entry, owner } = this.current(id)
        let origin = "about:blank"
        try {
          const url = new URL(entry.page.url())
          if (url.protocol === "http:" || url.protocol === "https:") origin = url.origin
        } catch {}
        result.push({
          id,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          source: owner.source,
          tier: owner.tier,
          browserId: owner.browserId,
          display: owner.headful ? (this.platform === "linux" ? "virtual-display" : "host-window") : "headless",
          state: owner.requestId ? "request" : owner.busy?.() ? "session-busy" : "session-idle",
          origin,
          observedAt: new Date(this.now()).toISOString(),
        })
      } catch {
        /* A page may close between the snapshot and its metadata read. */
      }
    }
    return {
      pages: result,
      truncated: this.omitted > 0,
      limits: browserPreviewLimits,
      headedDebug: {
        supported: this.platform === "darwin" || this.platform === "win32",
        configured: headedConfigured,
        display: this.platform === "linux" ? "virtual-display" : "host-window",
      },
    }
  }
  async preview(id: string): Promise<Uint8Array> {
    const { entry, owner } = this.current(id),
      now = this.now(),
      revision = entry.revision
    const cached = this.frames.get(id)
    if (cached && cached.revision === revision && now - cached.at < browserPreviewLimits.intervalMs) return cached.bytes
    let remaining = Infinity
    try {
      if (owner.remaining) remaining = owner.remaining()
      else if (owner.busy?.()) remaining = 0
    } catch {
      remaining = 0
    }
    if (remaining < browserPreviewLimits.timeoutMs + 1000)
      throw new BrowserObservationError(409, "Page operation has insufficient preview budget")
    this.starts = this.starts.filter((at) => now - at < browserPreviewLimits.intervalMs)
    if (
      this.inFlight >= 2 ||
      this.starts.length >= 2 ||
      this.capturing.has(id) ||
      now - entry.lastStarted < browserPreviewLimits.intervalMs
    )
      throw new BrowserObservationError(429, "Preview limit reached; retry after one second")
    const viewport = entry.page.viewportSize()
    if (viewport && (viewport.width <= 0 || viewport.height <= 0))
      throw new BrowserObservationError(409, "Page viewport is unavailable")
    this.starts.push(now)
    entry.lastStarted = now
    this.capturing.add(id)
    this.inFlight++
    const operation = Promise.resolve().then(() =>
      entry.page.screenshot({
        type: "jpeg",
        quality: 45,
        scale: "css",
        caret: "initial",
        timeout: browserPreviewLimits.timeoutMs,
        clip: {
          x: 0,
          y: 0,
          width: Math.min(viewport?.width ?? browserPreviewLimits.width, browserPreviewLimits.width),
          height: Math.min(viewport?.height ?? browserPreviewLimits.height, browserPreviewLimits.height),
        },
      }),
    )
    void operation.then(
      () => {
        this.inFlight--
        this.capturing.delete(id)
      },
      () => {
        this.inFlight--
        this.capturing.delete(id)
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const bytes = await Promise.race([
        operation,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), browserPreviewLimits.timeoutMs)
        }),
      ])
      if (!bytes) throw new BrowserObservationError(409, "Page preview timed out")
      if (this.closed || this.entries.get(id) !== entry || entry.revision !== revision)
        throw new BrowserObservationError(409, "Page changed during capture; refresh its metadata")
      if (bytes.byteLength > browserPreviewLimits.maxBytes)
        throw new BrowserObservationError(409, "Preview exceeds the image byte limit")
      for (const [key, value] of this.frames)
        if (now - value.at >= browserPreviewLimits.intervalMs) this.frames.delete(key)
      while (this.frames.size >= 2) {
        const oldest = this.frames.keys().next().value
        if (oldest) this.frames.delete(oldest)
        else break
      }
      this.frames.set(id, { bytes, revision, at: now })
      return bytes
    } catch (cause) {
      if (cause instanceof BrowserObservationError) throw cause
      throw new BrowserObservationError(409, "Page preview is unavailable")
    } finally {
      clearTimeout(timer)
    }
  }
  close() {
    this.closed = true
    for (const id of this.entries.keys()) this.remove(id)
    this.frames.clear()
  }
}
