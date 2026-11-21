import type { RequestCaptures, RequestHistoryEntry } from "@trawl/client"
import { LocalizedError } from "../utils/localization"
import { useErrorMessage } from "./useErrorMessage"
import { useRefreshRevision } from "./useRefreshRevision"

export function useSavedCaptures(
  request: () => Pick<RequestHistoryEntry, "id" | "at">,
  collection: "request" | "activity" = "request",
) {
  const desktop = useDesktopStore()
  const visible = useDocumentVisibility()
  const { revision, refresh, finish } = useRefreshRevision()
  usePageRefresh(refresh)
  const loading = shallowRef(false)
  const error = useErrorMessage()
  const key = computed(() => `${desktop.activeId}:${desktop.active?.baseURL}:${request().id}:${request().at}`)
  const record = shallowRef<{ key: string; value: RequestCaptures }>()
  const enabled = computed(
    () => desktop.native && desktop.capabilities?.captures && Boolean(request().id) && visible.value === "visible",
  )
  watch(
    [key, enabled, revision],
    async ([identity, allowed, refreshCount], _, onCleanup) => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let wake: (() => void) | undefined
      onCleanup(() => {
        finish(refreshCount)
        controller.abort()
        clearTimeout(timer)
        wake?.()
      })
      error.value = ""
      loading.value = false
      if (!allowed) {
        finish(refreshCount)
        record.value = undefined
        return
      }
      loading.value = true
      const reference = request()
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const api = desktop.client()
          const value = await (collection === "activity"
            ? api.sessions.activityCaptures(reference.id, { signal: controller.signal })
            : api.requests.captures(reference.id, { signal: controller.signal }))
          if (controller.signal.aborted || key.value !== identity) return
          if (value.requestAt !== reference.at) throw new LocalizedError("ui.captureBelongsToAnotherHistoryEntry")
          record.value = { key: identity, value }
          if (!value.artifacts.some((artifact) => artifact.state === "pending")) break
          await new Promise<void>((resolve) => {
            wake = resolve
            timer = setTimeout(resolve, 300)
          })
          wake = undefined
          timer = undefined
          if (controller.signal.aborted) return
        }
      } catch (cause) {
        if (!controller.signal.aborted && key.value === identity)
          error.value =
            cause instanceof Error || typeof cause === "string"
              ? cause
              : new LocalizedError("ui.couldNotReadSavedContentMetadata")
      } finally {
        finish(refreshCount)
        if (!controller.signal.aborted && key.value === identity) loading.value = false
      }
    },
    { immediate: true },
  )
  return {
    manifest: computed(() => (enabled.value && record.value?.key === key.value ? record.value.value : undefined)),
    loading,
    error,
    refresh,
  }
}
