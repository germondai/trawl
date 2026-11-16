import { expect, test } from "bun:test"
import { type DashboardSnapshot, Trawl } from "../src/index"

const snapshot: DashboardSnapshot = {
  startedAt: null,
  rangeMinutes: 60,
  retainedEvents: 0,
  requests: 0,
  successes: 0,
  failures: 0,
  averageMs: 0,
  bySource: {},
  byTier: {},
  bucketMs: 60000,
  timeline: [],
  domains: [],
  recentEvents: [],
}
test("metrics uses authenticated SDK transport with a validated range and snapshot", async () => {
  const requests: Request[] = []
  const client = new Trawl({
    baseURL: "https://owned.example/prefix",
    apiKey: "owned-token",
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json(snapshot)
    },
  })
  expect(await client.metrics(60)).toEqual(snapshot)
  expect(requests[0].url).toBe("https://owned.example/prefix/dashboard/metrics?minutes=60")
  expect(requests[0].headers.get("authorization")).toBe("Bearer owned-token")
  expect(() => client.metrics(2)).toThrow("range")
})
test.each([
  { byTier: { 3: null } },
  { recentEvents: [{}] },
  { timeline: [{ minute: "today", requests: -1 }] },
  { domains: [null] },
])("rejects malformed dashboard rows", async (override) => {
  const client = new Trawl({ fetch: async () => Response.json({ ...snapshot, ...override }) })
  await expect(client.metrics()).rejects.toMatchObject({ kind: "protocol" })
})
