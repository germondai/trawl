import type { SessionData } from "@trawl/types"
import { RedisClient } from "bun"

export class SessionCache {
  private redis: RedisClient
  private ttl: number

  constructor({ redisUrl, ttlSeconds }: { redisUrl: string; ttlSeconds: number }) {
    this.redis = new RedisClient(redisUrl)
    this.ttl = ttlSeconds
  }

  private key(domain: string): string {
    return `session:${domain}`
  }

  async save(domain: string, data: SessionData): Promise<void> {
    await this.redis.set(this.key(domain), JSON.stringify(data), "EX", this.ttl)
  }

  async load(domain: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.key(domain))
    if (!raw) return null
    try {
      return JSON.parse(raw) as SessionData
    } catch {
      return null
    }
  }

  async invalidate(domain: string): Promise<void> {
    await this.redis.del(this.key(domain))
  }
}
