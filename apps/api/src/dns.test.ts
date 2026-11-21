import { expect, test } from "bun:test"
import { createInstanceLookup, dnsProvider } from "./dns"
import { PublicEgressProxy } from "./public-egress"

test("instance DNS pins real HTTP connections without changing public-only policy", async () => {
  let queries = 0
  const lookup = createInstanceLookup("cloudflare", async (_provider, host, kind) => {
    expect(host).toBe("owned.fixture")
    queries++
    return { Status: 0, Answer: kind === 1 ? [{ type: 1, data: "127.0.0.1", TTL: 60 }] : [] }
  })
  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      expect(request.headers.get("proxy-authorization")).toBeNull()
      return new Response("instance resolver")
    },
  })
  const direct = new PublicEgressProxy({ lookup, publicOnly: false })
  const restricted = new PublicEgressProxy({ lookup })
  try {
    const target = `http://owned.fixture:${origin.port}/`
    expect(await (await fetch(target, { proxy: await direct.proxyFor() })).text()).toBe("instance resolver")
    expect((await fetch(target, { proxy: await restricted.proxyFor() })).status).toBe(400)
    expect(queries).toBe(2)
  } finally {
    await direct.close()
    await restricted.close()
    origin.stop(true)
  }
})

test("custom DNS fails closed and validates the preset", async () => {
  expect(dnsProvider(undefined)).toBe("system")
  expect(() => dnsProvider("__proto__")).toThrow()
  expect(() => dnsProvider("typo")).toThrow()
  const lookup = createInstanceLookup("google", async () => {
    throw new Error("provider offline")
  })
  await expect(lookup("owned.fixture")).rejects.toThrow("provider offline")
})
