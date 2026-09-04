import type { SessionData } from "@trawl/types"
import { RedisClient } from "bun"

export interface ISessionCache {
  connect(timeoutMs?: number): Promise<void>
  close(): void
  save(domain: string, data: SessionData): Promise<void>
  load(domain: string): Promise<SessionData | undefined>
  invalidate(domain: string): Promise<void>
}

export class SessionCache implements ISessionCache {
  private redis: RedisClient
  private ttl: number

  constructor({ redisUrl, ttlSeconds }: { redisUrl: string; ttlSeconds: number }) {
    this.redis = new RedisClient(redisUrl)
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
      this.redis.close()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  close(): void {
    this.redis.close()
  }

  private key(domain: string): string {
    return `session:${domain}`
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
