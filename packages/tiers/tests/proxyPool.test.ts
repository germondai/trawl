import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProxyPool } from "../src/utils/proxyRotator"

describe("ProxyPool", () => {
  test("round-robins across proxies for different domains", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080", "http://p3:8080"])
    const picks = [pool.next("a.com"), pool.next("b.com"), pool.next("c.com"), pool.next("d.com")]
    // 3 proxies, 4 picks (one new domain each) — round-robin wraps back to the first proxy
    expect(picks).toEqual(["http://p1:8080", "http://p2:8080", "http://p3:8080", "http://p1:8080"])
  })

  test("is sticky per-domain on repeat calls", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    const first = pool.next("example.com")
    for (let i = 0; i < 5; i++) {
      expect(pool.next("example.com")).toBe(first)
    }
  })

  test("markBad excludes the proxy and clears its sticky mapping", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    const first = pool.next("example.com")
    expect(first).toBeTruthy()

    pool.markBad(first as string)

    // Same domain must get a different proxy now (sticky mapping to the bad one was cleared)
    const after = pool.next("example.com")
    expect(after).not.toBe(first)
    expect(after).toBeTruthy()
  })

  test("returns null once every proxy is marked bad", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    pool.markBad("http://p1:8080")
    pool.markBad("http://p2:8080")
    expect(pool.next("example.com")).toBeNull()
    expect(pool.random()).toBeNull()
  })

  test("random() returns one of the configured proxies", () => {
    const urls = ["http://p1:8080", "http://p2:8080", "http://p3:8080"]
    const pool = new ProxyPool(urls)
    for (let i = 0; i < 20; i++) {
      expect(urls).toContain(pool.random())
    }
  })

  test("returns null for an empty pool", () => {
    const pool = new ProxyPool([])
    expect(pool.next()).toBeNull()
    expect(pool.random()).toBeNull()
    expect(pool.size).toBe(0)
  })

  describe("fromEnv", () => {
    let tmpDir: string | undefined

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    })

    test("parses a single proxy URL", () => {
      const pool = ProxyPool.fromEnv("http://p1:8080")
      expect(pool?.size).toBe(1)
    })

    test("parses a comma-separated list, trimming whitespace and dropping empties", () => {
      const pool = ProxyPool.fromEnv(" http://p1:8080 , http://p2:8080,,http://p3:8080 ")
      expect(pool?.size).toBe(3)
    })

    test("returns null when neither source has any proxies", () => {
      expect(ProxyPool.fromEnv(undefined, undefined)).toBeNull()
      expect(ProxyPool.fromEnv("", "")).toBeNull()
    })

    test("reads proxies from a line-delimited file, ignoring comments and blank lines", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "trawl-proxy-test-"))
      const file = join(tmpDir, "proxies.txt")
      writeFileSync(file, "http://p1:8080\n# a comment\n\nhttp://p2:8080\n")
      const pool = ProxyPool.fromEnv(undefined, file)
      expect(pool?.size).toBe(2)
    })

    test("merges the env-var list and the file list", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "trawl-proxy-test-"))
      const file = join(tmpDir, "proxies.txt")
      writeFileSync(file, "http://p2:8080\n")
      const pool = ProxyPool.fromEnv("http://p1:8080", file)
      expect(pool?.size).toBe(2)
    })
  })
})
