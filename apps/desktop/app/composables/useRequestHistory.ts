import type {
  ActiveRequest,
  RequestHistoryEntry,
  RequestHistoryQuery,
  RequestHistoryResponse,
  RequestLifecycle,
} from "@trawl/client"

export function useRequestHistory(showHistory: () => boolean = () => true) {
  const desktop = useDesktopStore()
  const query = ref<RequestHistoryQuery>({ sort: "newest" })
  const queryable = computed(() => Boolean(desktop.capabilities?.requestQuery))
  const filtered = computed(() =>
    Boolean(
      query.value.search ||
        query.value.source ||
        query.value.result ||
        query.value.tier !== undefined ||
        (query.value.sort && query.value.sort !== "newest"),
    ),
  )
  const total = shallowRef<number>()
  let latestTotal = 0
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let queryDirty = false
  let manualRefresh = false
  let disposed = false
  const scheduleQuery = () => {
    if (disposed) return
    if (manualRefresh) {
      queryDirty = true
      return
    }
    if (loadingMore.value) {
      queryDirty = true
      return
    }
    if (refreshTimer) return
    if (queryable.value && showHistory())
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        if (loadingMore.value) {
          queryDirty = true
          return
        }
        void loadPage(page.value)
      }, 250)
  }

  const latest = shallowRef<RequestHistoryEntry[]>([])
  const older = shallowRef<RequestHistoryEntry[]>([])
  const page = shallowRef(1)
  const cursors: (string | undefined)[] = [undefined]
  const entries = computed(() => (page.value === 1 && !filtered.value ? latest.value : older.value))
  let latestCursor: string | null = null
  let pageController: AbortController | undefined
  const active = shallowRef<ActiveRequest[]>([])
  const activeTruncated = shallowRef(false)
  const nextCursor = shallowRef<string | null>(null)
  const loadingMore = shallowRef(false)
  const pageError = shallowRef("")
  let generation = 0
  const feed = useInstanceFeed<RequestLifecycle, RequestHistoryResponse>({
    enabled: () => Boolean(desktop.capabilities?.requests),
    polling: () => !desktop.capabilities?.requestEvents,
    clear: () => {
      generation++
      clearTimeout(refreshTimer)
      refreshTimer = undefined
      queryDirty = false
      total.value = undefined
      query.value = { sort: "newest" }
      pageController?.abort()
      latest.value = []
      older.value = []
      page.value = 1
      cursors.splice(0, cursors.length, undefined)
      latestCursor = null
      active.value = []
      nextCursor.value = null
      activeTruncated.value = false
      pageError.value = ""
      loadingMore.value = false
    },
    snapshot: (api, signal) => api.requests.list({ limit: 20 }, { signal }),
    replace: (value) => {
      generation++
      loadingMore.value = false
      latest.value = value.entries
      latestTotal = value.total ?? value.entries.length
      if (!filtered.value) total.value = value.total
      if (!manualRefresh && (filtered.value || page.value > 1)) scheduleQuery()
      latestCursor = value.nextCursor
      active.value = value.active
      activeTruncated.value = value.activeTruncated
      if (page.value === 1) nextCursor.value = value.nextCursor
    },
    events: (api, options) => api.requests.events(options),
    apply: (events) => {
      let recent = new Map(latest.value.map((entry) => [entry.id, entry]))
      const pending = new Map(active.value.map((entry) => [entry.id, entry]))
      for (const { data: event } of events) {
        if (event.type === "started") {
          if (!recent.has(event.request.id)) pending.set(event.request.id, event.request)
        } else {
          pending.delete(event.request.id)
          if (event.persisted !== false) {
            if (recent.has(event.request.id)) recent.set(event.request.id, event.request)
            else {
              recent = new Map([[event.request.id, event.request], ...recent])
              latestTotal = Math.min(50000, latestTotal + 1)
            }
          }
        }
      }
      const ordered = [...recent.values()]
      latest.value = ordered.slice(0, 20)
      if (ordered.length > 20 || latestCursor) latestCursor = latest.value.at(-1)?.id ?? null
      if (page.value === 1) nextCursor.value = latestCursor
      if (!filtered.value && total.value !== undefined) total.value = latestTotal
      if (filtered.value && events.some(({ data }) => data.type !== "started")) scheduleQuery()
      activeTruncated.value ||= pending.size > 256
      active.value = [...pending.values()].slice(-256)
    },
  })
  // An overflowed view cannot infer which omitted requests are still running from deltas alone.
  watch([activeTruncated, feed.state], ([truncated, state], _, onCleanup) => {
    if (!truncated || state !== "live") return
    const timer = setTimeout(feed.refresh, 5_000)
    onCleanup(() => clearTimeout(timer))
  })
  async function loadPage(target: number) {
    if (!queryable.value) {
      if (target === page.value && target > 1) {
        await loadCursorPage(target, cursors[target - 1])
        return
      }
      while (target !== page.value) {
        const previous = page.value
        await movePage(target > page.value ? 1 : -1)
        if (page.value === previous) break
      }
      return
    }
    const controller = new AbortController()
    pageController?.abort()
    pageController = controller
    const serial = generation
    loadingMore.value = true
    pageError.value = ""
    try {
      const result = await desktop
        .client()
        .requests.list({ limit: 20, page: target, ...query.value }, { signal: controller.signal })
      if (controller.signal.aborted || serial !== generation) return
      total.value = result.total
      const lastPage = Math.max(1, Math.ceil((result.total ?? 0) / 20))
      if (target > lastPage) {
        await loadPage(lastPage)
        return
      }
      page.value = target
      older.value = result.entries
      if (target === 1 && !filtered.value) {
        latest.value = result.entries
        latestTotal = result.total ?? result.entries.length
      }
      nextCursor.value = result.nextCursor
    } catch (cause) {
      if (!controller.signal.aborted && serial === generation)
        pageError.value = cause instanceof Error ? cause.message : "Cannot load history"
    } finally {
      if (pageController === controller) {
        loadingMore.value = false
        if (queryDirty && !manualRefresh) {
          queryDirty = false
          scheduleQuery()
        }
      }
    }
  }
  watch(
    query,
    () => {
      generation++
      pageController?.abort()
      loadingMore.value = false
      clearTimeout(refreshTimer)
      refreshTimer = undefined
      queryDirty = false
      page.value = 1
      scheduleQuery()
    },
    { deep: true },
  )
  watch(showHistory, (value) => {
    if (value && filtered.value) scheduleQuery()
  })
  async function movePage(direction: -1 | 1) {
    if (loadingMore.value || (direction === -1 && page.value === 1) || (direction === 1 && !nextCursor.value)) return
    const target = page.value + direction
    if (target === 1) {
      pageController?.abort()
      page.value = 1
      older.value = []
      nextCursor.value = latestCursor
      pageError.value = ""
      return
    }
    const before = direction === 1 ? (nextCursor.value ?? undefined) : cursors[target - 1]
    await loadCursorPage(target, before)
  }
  async function loadCursorPage(target: number, before: string | undefined) {
    const serial = generation
    const controller = new AbortController()
    pageController?.abort()
    pageController = controller
    loadingMore.value = true
    pageError.value = ""
    try {
      const result = await desktop.client().requests.list({ limit: 20, before }, { signal: controller.signal })
      if (controller.signal.aborted || serial !== generation) return
      cursors[target - 1] = before
      page.value = target
      older.value = result.entries
      nextCursor.value = result.nextCursor
    } catch (cause) {
      if (!controller.signal.aborted && serial === generation)
        pageError.value = cause instanceof Error ? cause.message : "Cannot load history"
    } finally {
      if (pageController === controller) loadingMore.value = false
    }
  }
  usePageRefresh(async () => {
    manualRefresh = true
    clearTimeout(refreshTimer)
    refreshTimer = undefined
    try {
      await feed.refresh()
      if (disposed) return
      if (filtered.value || page.value > 1) await loadPage(page.value)
    } finally {
      manualRefresh = false
      if (queryDirty) {
        queryDirty = false
        scheduleQuery()
      }
    }
  })
  onBeforeUnmount(() => {
    disposed = true
    clearTimeout(refreshTimer)
    queryDirty = false
    pageController?.abort()
  })
  return {
    ...feed,
    query,
    queryable,
    total,
    loadPage,
    entries,
    latest,
    active,
    activeTruncated,
    nextCursor,
    loadingMore,
    pageError,
    page,
    movePage,
  }
}
