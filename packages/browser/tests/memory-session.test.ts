import { expect, test } from "bun:test"
import { MemorySessionCache } from "../src/memory-session"
import type { SessionData } from "@trawl/types"

const cookie: SessionData = {
  cookies: [
    {
      name: "cf_clearance",
      value: "abc123",
      domain: ".example.com",
      path: "/",
      expires: Date.now() / 1000 + 3600,
      httpOnly: true,
      secure: true,
    },
  ],
  userAgent: "Mozilla/5.0",
  savedAt: Date.now(),
}

test("MemorySessionCache.connect() resolves instantly", async () => {
  const cache = new MemorySessionCache({ ttlSeconds: 60 })
  await expect(cache.connect()).resolves.toBeUndefined()
})

test("MemorySessionCache saves and loads by domain", async () => {
  const cache = new MemorySessionCache({ ttlSeconds: 60 })
  await cache.save("example.com", cookie)
  const loaded = await cache.load("example.com")
  expect(loaded).toEqual(cookie)
})

test("MemorySessionCache returns undefined for unknown domain", async () => {
  const cache = new MemorySessionCache({ ttlSeconds: 60 })
  const loaded = await cache.load("nope.com")
  expect(loaded).toBeUndefined()
})

test("MemorySessionCache invalidate removes the entry", async () => {
  const cache = new MemorySessionCache({ ttlSeconds: 60 })
  await cache.save("example.com", cookie)
  await cache.invalidate("example.com")
  const loaded = await cache.load("example.com")
  expect(loaded).toBeUndefined()
})

test("MemorySessionCache expires entries after TTL", async () => {
  const cache = new MemorySessionCache({ ttlSeconds: 1 })
  await cache.save("example.com", cookie)
  expect(await cache.load("example.com")).toEqual(cookie)

  await new Promise((r) => setTimeout(r, 1100))
  const loaded = await cache.load("example.com")
  expect(loaded).toBeUndefined()
})

test("MemorySessionCache.prune removes only expired entries", async () => {
  const cache = new MemorySessionCache({ ttlSeconds: 1 })
  await cache.save("a.com", cookie)
  await cache.save("b.com", cookie)

  await new Promise((r) => setTimeout(r, 1100))
  await cache.save("c.com", cookie)

  const removed = cache.prune()
  expect(removed).toBe(2)
  expect(cache.size).toBe(1)
  expect(await cache.load("c.com")).toEqual(cookie)
})

test("MemorySessionCache overwrites on re-save", async () => {
  const cache = new MemorySessionCache({ ttlSeconds: 60 })
  await cache.save("example.com", cookie)
  const updated: SessionData = { ...cookie, userAgent: "Mozilla/5.0 (updated)" }
  await cache.save("example.com", updated)
  const loaded = await cache.load("example.com")
  expect(loaded?.userAgent).toBe("Mozilla/5.0 (updated)")
})
