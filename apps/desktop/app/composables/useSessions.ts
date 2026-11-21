import type { BrowserSession } from "@trawl/client"
import { LocalizedError } from "../utils/localization"
import { useErrorMessage } from "./useErrorMessage"

export function useSessions() {
  const desktop = useDesktopStore()
  const sessions = shallowRef<BrowserSession[]>([])
  const error = useErrorMessage()
  const loading = shallowRef(false)
  let controller: AbortController | undefined
  async function refresh() {
    controller?.abort()
    const abort = new AbortController()
    controller = abort
    const id = desktop.activeId
    loading.value = true
    error.value = ""
    try {
      const values = await desktop.client().sessions.list({ signal: abort.signal })
      if (!abort.signal.aborted && id === desktop.activeId) sessions.value = values
    } catch (cause) {
      if (!abort.signal.aborted && id === desktop.activeId)
        error.value =
          cause instanceof Error || typeof cause === "string" ? cause : new LocalizedError("ui.couldNotListSessions")
    } finally {
      if (!abort.signal.aborted && id === desktop.activeId) loading.value = false
    }
  }
  watch(
    [() => desktop.activeId, () => desktop.health?.status],
    () => {
      controller?.abort()
      sessions.value = []
      error.value = ""
      loading.value = false
      if (desktop.native && desktop.health?.status === "ok") void refresh()
    },
    { immediate: true },
  )
  usePageRefresh(refresh)
  onScopeDispose(() => controller?.abort())
  return { sessions, error, loading, refresh }
}
