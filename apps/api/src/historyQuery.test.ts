import { expect, test } from "bun:test"
import { parseHistoryQuery } from "./historyQuery"
import { MetricsStore } from "./metrics"

test("request queries search retained history beyond the first page and keep counts and sorting consistent", () => {
  const store = new MetricsStore(true)
  try {
    for (let index = 0; index < 65; index++)
      store.record({
        requestId: `query-${index}`,
        source: index % 2 ? "native" : "flaresolverr",
        url: `https://${index < 30 ? "needle" : "other"}.example/path`,
        statusCode: index % 3 ? 200 : 500,
        durationMs: index,
        tier: 1,
      })
    const first = store.history(20, undefined, { search: "needle" })
    expect(first.total).toBe(30)
    expect(first.entries).toHaveLength(20)
    const second = store.history(20, undefined, { search: "needle", page: 2 })
    expect(second.entries).toHaveLength(10)
    expect(second.entries[0]?.id).toBe("query-9")
    const failures = store.history(20, undefined, {
      search: "needle",
      source: "flaresolverr",
      result: "failed",
      tier: 1,
      sort: "slowest",
    })
    expect(failures.total).toBe(5)
    expect(failures.entries[0]?.durationMs).toBe(24)
    expect(store.history(20, undefined, { search: "' OR 1=1 --" }).total).toBe(0)
    expect(store.history().total).toBe(65)
  } finally {
    store.close()
  }
})

test("history query validation rejects ambiguous cursors, duplicate and unknown parameters", () => {
  expect(parseHistoryQuery(new URLSearchParams("page=2&source=native&sort=oldest&search=example&tier=3"))).toEqual({
    page: 2,
    source: "native",
    sort: "oldest",
    search: "example",
    tier: 3,
  })
  for (const query of [
    "page=0",
    "page=50001",
    "source=other",
    "result=invalid",
    "sort=duration_ms",
    "before=abc&page=1",
    "page=1&page=2",
    "token=secret",
    "search=%00",
  ])
    expect(() => parseHistoryQuery(new URLSearchParams(query))).toThrow()
})
