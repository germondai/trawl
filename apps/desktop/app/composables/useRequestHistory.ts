import type { ActiveRequest, RequestHistoryEntry, RequestHistoryResponse, RequestLifecycle } from "@trawl/client"

export function useRequestHistory() {
  const desktop = useDesktopStore()
  const entries = shallowRef<RequestHistoryEntry[]>([])
  const active = shallowRef<ActiveRequest[]>([])
  const activeTruncated = shallowRef(false)
  const nextCursor = shallowRef<string | null>(null)
  const loadingMore = shallowRef(false)
  const pageError = shallowRef("")
  let generation = 0
  const feed = useInstanceFeed<RequestLifecycle, RequestHistoryResponse>({
    enabled: () => Boolean(desktop.capabilities?.requests && desktop.capabilities.requestEvents),
    clear: () => {
      generation++
      entries.value = []
      active.value = []
      nextCursor.value = null
      activeTruncated.value = false
      pageError.value = ""
      loadingMore.value = false
    },
    snapshot: (api, signal) => api.requests.list({ limit: 100 }, { signal }),
    replace: (value) => {
      generation++
      loadingMore.value = false
      entries.value = value.entries
      active.value = value.active
      activeTruncated.value = value.activeTruncated
      nextCursor.value = value.nextCursor
    },
    events: (api, options) => api.requests.events(options),
    apply: (events) => {
      const recent = new Map(entries.value.map((entry) => [entry.id, entry]))
      const pending = new Map(active.value.map((entry) => [entry.id, entry]))
      for (const { data: event } of events) {
        if (event.type === "started") {
          if (!recent.has(event.request.id)) pending.set(event.request.id, event.request)
        } else {
          pending.delete(event.request.id)
          recent.set(event.request.id, event.request)
        }
      }
      entries.value = [...recent.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500)
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
  async function loadMore() {
    if (!nextCursor.value || loadingMore.value || entries.value.length >= 500) return
    const serial = generation
    loadingMore.value = true
    pageError.value = ""
    try {
      const page = await desktop.client().requests.list({ limit: 100, before: nextCursor.value })
      if (serial !== generation) return
      entries.value = [
        ...new Map([...entries.value, ...page.entries].map((entry) => [entry.id, entry])).values(),
      ].slice(0, 500)
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (serial === generation) pageError.value = cause instanceof Error ? cause.message : "Cannot load history"
    } finally {
      if (serial === generation) loadingMore.value = false
    }
  }
  return { ...feed, entries, active, activeTruncated, nextCursor, loadingMore, pageError, loadMore }
}
