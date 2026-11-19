import { expect, test } from "bun:test"
import { computed, nextTick, ref, shallowRef, watch } from "vue"
import { useRequestHistory } from "../app/composables/useRequestHistory"
import { useSettingFocus } from "../app/composables/useSettingFocus"
import { cyclePage } from "../app/utils/page-history"
import type { settingSections } from "../app/utils/settings"

test("page cycling follows sidebar order and wraps in either direction", () => {
  expect(cyclePage("overview", 1)).toBe("history")
  expect(cyclePage("sessions", 1)).toBe("workbench")
  expect(cyclePage("settings", 1)).toBe("overview")
  expect(cyclePage("overview", -1)).toBe("settings")
})

test("history pages follow server cursors while live arrivals leave an older page stable", async () => {
  let feed: any
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: `row-${index}`,
    at: new Date(100000).toISOString(),
  }))
  const list = async ({ before, limit }: { before?: string; limit: number }) => {
    const offset = before ? rows.findIndex((row) => row.id === before) + 1 : 0
    const entries = rows.slice(offset, offset + limit)
    return {
      entries,
      active: [],
      activeTruncated: false,
      cursor: "fixture:1",
      nextCursor: offset + limit < rows.length ? entries.at(-1)?.id : null,
    }
  }
  Object.assign(globalThis, {
    computed,
    ref,
    shallowRef,
    watch,
    onBeforeUnmount: () => {},
    usePageRefresh: () => {},
    useDesktopStore: () => ({ client: () => ({ requests: { list } }) }),
    useInstanceFeed: (options: unknown) => {
      feed = options
      return { state: shallowRef("paused"), refresh: () => {} }
    },
  })
  const history = useRequestHistory()
  feed.replace(await list({ limit: 20 }))
  expect(history.entries.value).toHaveLength(20)
  await history.movePage(1)
  expect(history.page.value).toBe(2)
  expect(history.entries.value[0]?.id).toBe("row-20")
  feed.apply([{ data: { type: "completed", request: { id: "new", at: new Date(100000).toISOString() } } }])
  expect(history.entries.value[0]?.id).toBe("row-20")
  expect(history.latest.value[0]?.id).toBe("new")
  await history.movePage(1)
  expect(history.entries.value).toHaveLength(5)
  expect(history.nextCursor.value).toBeNull()
  await history.movePage(-1)
  expect(history.entries.value[0]?.id).toBe("row-20")
  await history.loadPage(1)
  expect(history.entries.value[0]?.id).toBe("new")
  await history.loadPage(3)
  expect(history.page.value).toBe(3)
  await history.loadPage(1)
  expect(history.page.value).toBe(1)
  feed.clear()
  expect(history.page.value).toBe(1)
  expect(history.entries.value).toEqual([])
})

test("queryable history fetches requested pages and filters across the complete retained history", async () => {
  let feed: any
  const calls: any[] = []
  const list = async (query: any) => {
    calls.push(query)
    return {
      entries: [{ id: `page-${query.page ?? 1}-${query.search ?? "all"}` }],
      total: query.search ? 1 : 65,
      nextCursor: null,
      active: [],
      activeTruncated: false,
      cursor: "fixture:1",
    }
  }
  Object.assign(globalThis, {
    computed,
    ref,
    shallowRef,
    watch,
    onBeforeUnmount: () => {},
    usePageRefresh: () => {},
    useDesktopStore: () => ({ capabilities: { requestQuery: true }, client: () => ({ requests: { list } }) }),
    useInstanceFeed: (options: unknown) => {
      feed = options
      return { state: shallowRef("paused"), refresh: () => {} }
    },
  })
  const history = useRequestHistory()
  feed.replace(await list({ limit: 20 }))
  await history.loadPage(3)
  expect(history.page.value).toBe(3)
  expect(history.entries.value[0]?.id).toBe("page-3-all")
  history.query.value.search = "owned.test"
  await nextTick()
  await Bun.sleep(280)
  expect(history.page.value).toBe(1)
  expect(history.entries.value[0]?.id).toBe("page-1-owned.test")
  expect(history.total.value).toBe(1)
  expect(calls.at(-1)).toMatchObject({ page: 1, search: "owned.test", sort: "newest" })
})

test("live completions coalesce behind an in-flight filtered history query", async () => {
  let feed: any
  let cleanup = () => {}
  const signals: AbortSignal[] = []
  let finish: ((value: any) => void) | undefined
  Object.assign(globalThis, {
    computed,
    ref,
    shallowRef,
    watch,
    onBeforeUnmount: (fn: () => void) => {
      cleanup = fn
    },
    useDesktopStore: () => ({
      capabilities: { requestQuery: true },
      client: () => ({
        requests: {
          list: (_: unknown, { signal }: { signal: AbortSignal }) => {
            signals.push(signal)
            return new Promise((resolve) => {
              finish = resolve
            })
          },
        },
      }),
    }),
    useInstanceFeed: (options: unknown) => {
      feed = options
      return { state: shallowRef("paused"), refresh: () => {} }
    },
  })
  const history = useRequestHistory()
  history.query.value.search = "owned.test"
  await nextTick()
  const pending = history.loadPage(1)
  for (let index = 0; index < 6; index++) {
    feed.apply([{ data: { type: "completed", persisted: true, request: { id: `new-${index}` } } }])
    await Bun.sleep(60)
  }
  expect(signals).toHaveLength(1)
  expect(signals[0]?.aborted).toBe(false)
  finish?.({ entries: [{ id: "filtered" }], total: 1, nextCursor: null })
  await pending
  expect(history.entries.value[0]?.id).toBe("filtered")
  cleanup()
})

test("setting links are consumed once and their highlight expires without restoring a cleared query", async () => {
  let expire: (() => void) | undefined
  let scrolled = 0
  const oldInject = (globalThis as any).inject
  const oldTimeout = globalThis.setTimeout
  const oldDocument = globalThis.document
  Object.assign(globalThis, {
    watch,
    shallowRef,
    nextTick,
    inject: () => () => {
      scrolled++
    },
    onBeforeUnmount: () => {},
    usePageRefresh: () => {},
    document: { getElementById: () => ({ scrollIntoView() {}, querySelector: () => ({ focus() {} }) }) },
    setTimeout: (fn: () => void) => {
      expire = fn
      return 1
    },
  })
  try {
    const target = shallowRef<{ name: string; revision: number } | undefined>({
      name: "HISTORY_CAPTURE_REQUESTS",
      revision: 1,
    })
    const query = ref("")
    const selected = ref<(typeof settingSections)[number]["id"]>("general")
    const settings = ref([{ name: "HISTORY_CAPTURE_REQUESTS", group: "metrics" }])
    const { highlighted } = useSettingFocus(
      () => target.value,
      () => settings.value,
      query,
      selected,
      () => {
        target.value = undefined
      },
    )
    await nextTick()
    expect(query.value).toBe("HISTORY_CAPTURE_REQUESTS")
    expect(target.value).toBeUndefined()
    expect(highlighted.value).toBe("HISTORY_CAPTURE_REQUESTS")
    expect(scrolled).toBe(0)
    selected.value = "browser"
    await nextTick()
    await nextTick()
    expect(scrolled).toBe(1)
    expire?.()
    expect(highlighted.value).toBe("")
    query.value = ""
    settings.value = [...settings.value, { name: "PORT", group: "port" }]
    await nextTick()
    expect(query.value).toBe("")
  } finally {
    globalThis.setTimeout = oldTimeout
    globalThis.document = oldDocument
    ;(globalThis as any).inject = oldInject
  }
})
