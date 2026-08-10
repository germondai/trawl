import { describe, expect, test } from "bun:test"
import { tier4ProxyUnavailableMessage } from "../src/orchestrator"
import { ProxyPool } from "../src/utils/proxyRotator"

describe("Tier 4 proxy availability errors", () => {
  test("distinguishes a configured cooling pool from missing configuration", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    pool.markBad("http://p1:8080")
    pool.markBad("http://p2:8080")

    expect(pool.next("example.com")).toBeUndefined()
    const message = tier4ProxyUnavailableMessage({ status: "blocked", reason: "http-403" }, pool)
    expect(message).toContain("Residential proxy pool is configured")
    expect(message).toContain("cooling down")
    expect(message).not.toContain("Set RESIDENTIAL_PROXY_URL")
  })

  test("retains configuration guidance when no residential pool exists", () => {
    const message = tier4ProxyUnavailableMessage({ status: "blocked", reason: "http-403" })
    expect(message).toContain("Set RESIDENTIAL_PROXY_URL")
    expect(message).not.toContain("cooling down")
  })
})
