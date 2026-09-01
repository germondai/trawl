import type { SessionData } from "@trawl/types"
import type { ISessionCache } from "./session"

interface Entry {
  data: SessionData
  expiresAt: number
}

/**
 * In-process session cache backed by a plain Map. Zero external dependencies,
 * zero network latency. Sessions are scoped to this process — if you run
 * multiple API instances behind a load balancer, each instance keeps its own
 * independent cache and a solve on instance A is NOT visible to instance B.
 * Use the Redis driver when cross-instance sharing is required.
 */
export class MemorySessionCache implements ISessionCache {
  private store = new Map<string, Entry>()
  private ttl: number

  constructor({ ttlSeconds }: { ttlSeconds: number }) {
    this.ttl = ttlSeconds
  }

  async connect(): Promise<void> {
    // No-op — nothing to connect to.
  }

  close(): void {
    // No-op — nothing to close.
  }

  private key(domain: string): string {
    return `session:${domain}`
  }

  async save(domain: string, data: SessionData): Promise<void> {
    this.store.set(this.key(domain), {
      data,
      expiresAt: Date.now() + this.ttl * 1000,
    })
  }

  async load(domain: string): Promise<SessionData | undefined> {
    const entry = this.store.get(this.key(domain))
    if (!entry) return
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(this.key(domain))
      return
    }
    return entry.data
  }

  async invalidate(domain: string): Promise<void> {
    this.store.delete(this.key(domain))
  }

  /** Remove all expired entries. Call periodically if the workload is
   *  high-churn and you want to bound memory growth. */
  prune(): number {
    let removed = 0
    const now = Date.now()
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
