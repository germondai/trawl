import type { SessionData } from "@trawl/types"
import type { SessionCacheStore } from "./session"

interface Entry {
  data: SessionData
  expiresAt: number
}

/**
 * In-process session cache backed by a plain Map. Zero external dependencies,
 * zero network latency. Sessions are scoped to this process - if you run
 * multiple API instances behind a load balancer, each instance keeps its own
 * independent cache and a solve on instance A is NOT visible to instance B.
 * Use the Redis driver when cross-instance sharing is required.
 */
export class MemorySessionCache implements SessionCacheStore {
  private store = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor({
    ttlSeconds,
    maxEntries = 1_000,
    now = Date.now,
  }: {
    ttlSeconds: number
    maxEntries?: number
    now?: () => number
  }) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("Memory session cache TTL must be a positive integer")
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Memory session cache max entries must be a positive integer")
    }
    this.ttlMs = ttlSeconds * 1_000
    this.maxEntries = maxEntries
    this.now = now
  }

  async connect(): Promise<void> {
    // No-op — nothing to connect to.
  }

  close(): void {
    this.store.clear()
  }

  private key(domain: string): string {
    return `session:${domain}`
  }

  async save(domain: string, data: SessionData): Promise<void> {
    this.prune()
    const key = this.key(domain)
    this.store.delete(key)
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
    this.store.set(key, {
      data: structuredClone(data),
      expiresAt: this.now() + this.ttlMs,
    })
  }

  async load(domain: string): Promise<SessionData | undefined> {
    const key = this.key(domain)
    const entry = this.store.get(key)
    if (!entry) return
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key)
      return
    }
    // Map preserves insertion order. Reinsert a hit so capacity eviction is LRU.
    this.store.delete(key)
    this.store.set(key, entry)
    return structuredClone(entry.data)
  }

  async invalidate(domain: string): Promise<void> {
    this.store.delete(this.key(domain))
  }

  /** Remove all expired entries. Saves call this automatically. */
  prune(): number {
    let removed = 0
    const now = this.now()
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key)
        removed++
      }
    }
    return removed
  }

  get size(): number {
    return this.store.size
  }
}
