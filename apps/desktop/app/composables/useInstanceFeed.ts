import type { JournalEntry, StreamEvent, StreamOptions, Trawl } from "@trawl/client"
import { LocalizedError } from "../utils/localization"
import { useErrorMessage } from "./useErrorMessage"
import { useRefreshRevision } from "./useRefreshRevision"

export function useInstanceFeed<T, Snapshot extends { cursor: string }>(options: {
  enabled: () => boolean
  polling?: () => boolean
  snapshot: (api: Trawl, signal: AbortSignal) => Promise<Snapshot>
  replace: (snapshot: Snapshot) => void
  events: (api: Trawl, options: StreamOptions) => AsyncGenerator<StreamEvent<T>>
  apply: (entries: JournalEntry<T>[]) => void
  clear: () => void
}) {
  const desktop = useDesktopStore()
  const visible = useDocumentVisibility()
  const error = useErrorMessage()
  const state = shallowRef<"paused" | "connecting" | "live" | "reconnecting">("paused")
  const { revision, refresh, finish } = useRefreshRevision()
  watch(
    [() => desktop.activeId, visible, options.enabled, revision],
    async ([id, visibility, enabled, refreshCount], previous, onCleanup) => {
      const abort = new AbortController()
      let current = true
      let timer: ReturnType<typeof setTimeout> | undefined
      let batch: JournalEntry<T>[] = []
      const flush = () => {
        clearTimeout(timer)
        timer = undefined
        if (current && desktop.activeId === id && batch.length) options.apply(batch)
        batch = []
      }
      onCleanup(() => {
        finish(refreshCount)
        current = false
        abort.abort()
        clearTimeout(timer)
        batch = []
      })
      if (id !== previous?.[0]) options.clear()
      error.value = ""
      if (!desktop.native || visibility !== "visible" || !enabled) {
        finish(refreshCount)
        state.value = "paused"
        return
      }
      let retryMs = 1_000
      while (current && desktop.activeId === id) {
        state.value = retryMs === 1_000 ? "connecting" : "reconnecting"
        try {
          const api = desktop.client()
          const snapshot = await options.snapshot(api, abort.signal)
          if (!current || desktop.activeId !== id) return
          options.replace(snapshot)
          finish(refreshCount)
          if (options.polling?.()) {
            state.value = "live"
            error.value = ""
            await new Promise<void>((resolve) => {
              const cancel = () => {
                clearTimeout(wait)
                resolve()
              }
              const wait = setTimeout(() => {
                abort.signal.removeEventListener("abort", cancel)
                resolve()
              }, 2000)
              abort.signal.addEventListener("abort", cancel, { once: true })
              if (abort.signal.aborted) cancel()
            })
            continue
          }
          for await (const event of options.events(api, { cursor: snapshot.cursor, signal: abort.signal })) {
            if (!current || desktop.activeId !== id) return
            if (event.type === "reset") {
              flush()
              break
            }
            state.value = "live"
            error.value = ""
            retryMs = 1_000
            if (event.type === "entry") {
              batch.push({ id: event.id, data: event.data })
              if (batch.length >= 256) flush()
              else if (!timer) timer = setTimeout(flush, 50)
            }
          }
          flush()
        } catch (cause) {
          if (!current || desktop.activeId !== id) return
          flush()
          finish(refreshCount)
          error.value =
            cause instanceof Error || typeof cause === "string"
              ? cause
              : new LocalizedError("ui.liveUpdatesAreUnavailable")
          state.value = "reconnecting"
        }
        if (!current || desktop.activeId !== id) return
        await new Promise<void>((resolve) => {
          const cancel = () => {
            clearTimeout(wait)
            resolve()
          }
          const wait = setTimeout(() => {
            abort.signal.removeEventListener("abort", cancel)
            resolve()
          }, retryMs)
          abort.signal.addEventListener("abort", cancel, { once: true })
          if (abort.signal.aborted) cancel()
        })
        retryMs = Math.min(retryMs * 2, 10_000)
      }
    },
    { immediate: true },
  )
  return { state, error, refresh }
}
