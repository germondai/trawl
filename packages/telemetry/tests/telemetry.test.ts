import { expect, test } from "bun:test"
import { usageBatch, usageEvent, usageReporter } from "../src/index"

test("usage is a fixed allowlist without target secrets, IPs or persistent identities", () => {
  for (const [label, expected] of [
    ["recaptcha-v2", "recaptcha"],
    ["turnstile:2captcha", "turnstile"],
    ["recaptcha-v2:2captcha", "recaptcha"],
    ["cloudflare-challenge:2captcha", "cloudflare"],
    ["cloudflare-persistent", "cloudflare"],
    ["private-unrecognized-value", "unknown"],
  ] as const)
    expect(
      usageEvent({
        url: "https://public.fixture.com",
        success: true,
        durationMs: 10,
        version: "1.11.1",
        challenge: label,
      })?.challenge,
    ).toBe(expected)
  const event = usageEvent({
    url: "https://user:password@public.fixture.com/private?token=secret",
    challenge: "turnstile",
    success: true,
    durationMs: 125,
    version: "1.11.1",
  })
  expect(event).toEqual({
    domain: "public.fixture.com",
    challenge: "turnstile",
    success: true,
    durationMs: 130,
    version: "1.11.1",
  })
  for (const url of [
    "http://127.0.0.1",
    "http://[::1]",
    "http://localhost",
    "http://intranet",
    "http://host.internal",
    "file:///tmp/secret",
  ])
    expect(usageEvent({ url, success: true, durationMs: 1, version: "1.11.1" })).toBeUndefined()
  expect(usageBatch({ events: [{ ...event, payload: "private" }] })).toBeUndefined()
  expect(usageBatch({ events: Array(21).fill(event) })).toBeUndefined()
})
test("opt-out performs no requests; opt-in sends bounded batches without auth, cookies or redirects", async () => {
  const calls: RequestInit[] = []
  const transport: typeof fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      if (init) calls.push(init)
      return new Response(null, { status: 202 })
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch
  const event = { url: "https://public.fixture.com/private", success: true, durationMs: 1 }
  const off = usageReporter({ enabled: false, endpoint: "", version: "1.11.1", fetch: transport })
  off.record(event)
  await off.flush()
  expect(calls).toHaveLength(0)
  off.close()
  const on = usageReporter({
    enabled: true,
    endpoint: "https://collector.fixture.com/v1/events",
    version: "1.11.1",
    fetch: transport,
  })
  for (let i = 0; i < 200; i++) on.record(event)
  await on.flush()
  expect(calls).toHaveLength(1)
  expect(JSON.parse(String(calls[0]?.body)).events).toHaveLength(20)
  expect(calls[0]).toMatchObject({
    redirect: "error",
    credentials: "omit",
    headers: { "content-type": "application/json" },
  })
  on.close()
  await on.flush()
  expect(calls).toHaveLength(1)
  expect(() => usageReporter({ enabled: true, endpoint: "http://collector.fixture.com", version: "1.11.1" })).toThrow()
})
