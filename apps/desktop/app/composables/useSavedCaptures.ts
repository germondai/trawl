import type { RequestCaptures, RequestHistoryEntry } from "@trawl/client"

export function useSavedCaptures(request: () => Pick<RequestHistoryEntry, "id" | "at">) {
  const desktop = useDesktopStore()
  const visible = useDocumentVisibility()
  const revision = shallowRef(0)
  const loading = shallowRef(false)
  const error = shallowRef("")
  const key = computed(() => `${desktop.activeId}:${desktop.active?.baseURL}:${request().id}:${request().at}`)
  const record = shallowRef<{ key: string; value: RequestCaptures }>()
  const enabled = computed(() => desktop.native && desktop.capabilities?.captures && visible.value === "visible")
  watch(
    [key, enabled, revision],
    async ([identity, allowed], _, onCleanup) => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let wake: (() => void) | undefined
      onCleanup(() => {
        controller.abort()
        clearTimeout(timer)
        wake?.()
      })
      error.value = ""
      loading.value = false
      if (!allowed) {
        record.value = undefined
        return
      }
      loading.value = true
      const reference = request()
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const value = await desktop.client().requests.captures(reference.id, { signal: controller.signal })
          if (controller.signal.aborted || key.value !== identity) return
          if (value.requestAt !== reference.at) throw new Error("Capture belongs to another history entry")
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
          error.value = cause instanceof Error ? cause.message : "Could not read saved-content metadata"
      } finally {
        if (!controller.signal.aborted && key.value === identity) loading.value = false
      }
    },
    { immediate: true },
  )
  return {
    manifest: computed(() => (enabled.value && record.value?.key === key.value ? record.value.value : undefined)),
    loading,
    error,
    refresh: () => {
      revision.value++
    },
  }
}
