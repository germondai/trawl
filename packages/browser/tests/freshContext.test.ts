import { describe, expect, test } from "bun:test"
import { closeTemporaryContext, newFreshContext } from "../src/pool"
import { toPlaywrightProxy } from "../src/proxy"

describe("newFreshContext", () => {
  test("passes authenticated proxy credentials separately from the server URL", async () => {
    let receivedOptions: unknown
    const context = { addInitScript: async () => {} }
    const browser = {
      newContext: async (options: unknown) => {
        receivedOptions = options
        return context
      },
    }

    expect(await newFreshContext(browser, { proxy: "http://user:p%40ss@proxy.example.com:8080" })).toBe(context)
    expect(receivedOptions).toMatchObject({
      proxy: {
        server: "http://proxy.example.com:8080",
        username: "user",
        password: "p@ss",
      },
    })
  })

  test("keeps unauthenticated proxy URLs as server-only options", () => {
    expect(toPlaywrightProxy("https://proxy.example.com:8443")).toEqual({
      server: "https://proxy.example.com:8443",
    })
  })

  test("preserves SOCKS5 and IPv6 endpoints while decoding credentials", () => {
    expect(toPlaywrightProxy("socks5://user%40org:p%3Aass@[2001:db8::1]:1080")).toEqual({
      server: "socks5://[2001:db8::1]:1080",
      username: "user@org",
      password: "p:ass",
    })
  })

  test("relaxes certificate verification only when the request asked for it", async () => {
    const seen: Record<string, unknown>[] = []
    const browser = {
      newContext: async (options: Record<string, unknown>) => {
        seen.push(options)
        return { addInitScript: async () => {} }
      },
    }

    await newFreshContext(browser, { ignoreHttpsErrors: true })
    await newFreshContext(browser)

    expect(seen[0]).toMatchObject({ ignoreHTTPSErrors: true })
    expect(seen[1]).not.toHaveProperty("ignoreHTTPSErrors")
  })

  test("closes a partially initialized context", async () => {
    let closed = false
    let created = 0
    const browser = {
      newContext: async () => ({
        addInitScript: async () => {
          throw new Error("init failed")
        },
        close: async () => {
          closed = true
        },
      }),
    }
    await expect(newFreshContext(browser, { onCreated: () => created++ })).rejects.toThrow("init failed")
    expect(created).toBe(1)
    expect(closed).toBe(true)
  })

  test("cleanup timeout requests a rolling replacement", async () => {
    let reason = ""
    await closeTemporaryContext(
      { close: () => new Promise<void>(() => {}) },
      (value) => (reason = value),
      "cleanup wedged",
      10,
    )
    expect(reason).toBe("cleanup wedged")
  })
})
