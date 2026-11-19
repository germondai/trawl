import { expect, test } from "bun:test"
import { computed, effectScope, nextTick, ref, shallowRef, watch } from "vue"
import { useRequestHistory } from "../app/composables/useRequestHistory"

type Query = { before?: string; limit?: number; search?: string }
type Snapshot = {
  entries: { id: string; version?: number }[]
  total?: number
  active: never[]
  activeTruncated: boolean
  cursor: string
  nextCursor: string | null
}
function fixture(
  queryable: boolean,
  list: (query: Query, options: { signal: AbortSignal }) => Promise<Snapshot>,
  snapshot: () => Promise<Snapshot>,
) {
  let feed: { replace: (snapshot: Snapshot) => void }
  let refresh: () => Promise<void>
  let cleanup = () => {}
  const globals = {
    computed,
    ref,
    shallowRef,
    watch,
    onBeforeUnmount: (fn: () => void) => {
      cleanup = fn
    },
    usePageRefresh: (fn: () => Promise<void>) => {
      refresh = fn
    },
    useDesktopStore: () => ({ capabilities: { requestQuery: queryable }, client: () => ({ requests: { list } }) }),
    useInstanceFeed: (options: { replace: (snapshot: Snapshot) => void }) => {
      feed = options
      return { state: shallowRef("paused"), refresh: async () => options.replace(await snapshot()) }
    },
  }
  const target = globalThis as unknown as Record<string, unknown>
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, target[key]]))
  Object.assign(target, globals)
  const scope = effectScope()
  const history = scope.run(() => useRequestHistory())!
  return {
    history,
    seed: async () => feed.replace(await snapshot()),
    refresh: () => refresh(),
    dispose() {
      cleanup()
      scope.stop()
      Object.assign(target, previous)
    },
  }
}
const snapshot = (): Snapshot => ({
  entries: [{ id: "latest" }],
  total: 40,
  active: [],
  activeTruncated: false,
  cursor: "fixture",
  nextCursor: "next",
})

test("refresh reloads the current cursor page without changing position", async () => {
  let version = 0
  const calls: Query[] = []
  const rows = Array.from({ length: 45 }, (_, index) => ({ id: `row-${index}` }))
  const list = async ({ before, limit = 20 }: Query) => {
    calls.push({ before, limit })
    const offset = before ? rows.findIndex((row) => row.id === before) + 1 : 0
    const entries = rows.slice(offset, offset + limit).map((row) => ({ ...row, version }))
    return { ...snapshot(), entries, nextCursor: offset + limit < rows.length ? entries.at(-1)!.id : null }
  }
  const fx = fixture(false, list, () => list({ limit: 20 }))
  try {
    await fx.seed()
    await fx.history.movePage(1)
    version = 1
    await fx.refresh()
    expect(fx.history.page.value).toBe(2)
    expect(fx.history.entries.value[0]).toMatchObject({ id: "row-20", version: 1 })
    expect(calls.at(-1)).toEqual({ before: "row-19", limit: 20 })
  } finally {
    fx.dispose()
  }
})

test("filter changes during refresh run after the interrupted query", async () => {
  let delayOld = false
  const started = Promise.withResolvers<void>()
  const calls: string[] = []
  const list = async (query: Query, { signal }: { signal: AbortSignal }) => {
    calls.push(query.search ?? "")
    if (delayOld && query.search === "old")
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        started.resolve()
      })
    return { ...snapshot(), entries: [{ id: query.search ?? "" }], total: 1 }
  }
  const fx = fixture(true, list, async () => snapshot())
  try {
    await fx.seed()
    fx.history.query.value.search = "old"
    await nextTick()
    await fx.history.loadPage(1)
    delayOld = true
    const pending = fx.refresh()
    await started.promise
    fx.history.query.value.search = "new"
    await nextTick()
    await pending
    await Bun.sleep(300)
    expect(calls).toEqual(["old", "old", "new"])
    expect(fx.history.entries.value[0]?.id).toBe("new")
    expect(fx.history.loadingMore.value).toBe(false)
  } finally {
    fx.dispose()
  }
})

test("leaving history while refreshing starts no query after teardown", async () => {
  const delayed = Promise.withResolvers<Snapshot>()
  let wait = false
  let reads = 0
  const fx = fixture(
    true,
    async () => {
      reads++
      return snapshot()
    },
    () => (wait ? delayed.promise : Promise.resolve(snapshot())),
  )
  await fx.seed()
  fx.history.query.value.search = "owned"
  await nextTick()
  await fx.history.loadPage(1)
  wait = true
  const pending = fx.refresh()
  fx.dispose()
  delayed.resolve(snapshot())
  await pending
  expect(reads).toBe(1)
})
