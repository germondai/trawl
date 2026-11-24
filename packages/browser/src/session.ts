import type { SessionData } from "@trawl/types"
import { RedisClient } from "bun"

export interface SessionCacheStore {
  connect(timeoutMs?: number): Promise<void>
  close(): void
  onLost?(listener: () => void): void
  save(domain: string, data: SessionData): Promise<void>
  load(domain: string): Promise<SessionData | undefined>
  invalidate(domain: string): Promise<void>
}

export class SessionCache implements SessionCacheStore {
  private redis: RedisClient
  private ttl: number

  constructor({ redisUrl, ttlSeconds }: { redisUrl: string; ttlSeconds: number }) {
    this.redis = new RedisClient(redisUrl, { autoReconnect: false, enableOfflineQueue: false })
    this.ttl = ttlSeconds
  }

  async connect(timeoutMs = 1_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.redis.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Redis connection timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
      ])
    } catch (error) {
      this.close()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  close(): void {
    this.redis.onclose = null
    this.redis.close()
  }

  onLost(listener: () => void): void {
    this.redis.onclose = listener
  }

  private key(domain: string): string {
    // Old entries do not identify their proxy and cannot be replayed safely.
    return `session:v2:${domain}`
  }

  async save(domain: string, data: SessionData): Promise<void> {
    await this.redis.set(this.key(domain), JSON.stringify(data), "EX", this.ttl)
  }

  async load(domain: string) {
    const raw = await this.redis.get(this.key(domain))
    if (!raw) return
    try {
      return JSON.parse(raw) as SessionData
    } catch {
      return
    }
  }

  async invalidate(domain: string): Promise<void> {
    await this.redis.del(this.key(domain))
  }
}
