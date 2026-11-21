import type { RequestArtifact, RequestHistoryEntry } from "@trawl/client"
import { LocalizedError } from "../utils/localization"
import { useErrorMessage } from "./useErrorMessage"

export function useCaptureArtifact(
  request: () => Pick<RequestHistoryEntry, "id" | "at">,
  artifact: () => RequestArtifact | undefined,
  collection: "request" | "activity" = "request",
) {
  const desktop = useDesktopStore()
  const visible = useDocumentVisibility()
  const revision = shallowRef(0)
  const loading = shallowRef(false)
  const error = useErrorMessage()
  const key = computed(
    () =>
      `${desktop.activeId}:${desktop.active?.baseURL}:${request().id}:${request().at}:${artifact()?.kind}:${artifact()?.sha256}`,
  )
  const record = shallowRef<{ key: string; value: Uint8Array }>()
  const enabled = computed(
    () =>
      desktop.native && desktop.capabilities?.captures && artifact()?.state === "ready" && visible.value === "visible",
  )
  watch(
    [key, enabled, revision],
    async ([identity, allowed], _, onCleanup) => {
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      record.value = undefined
      error.value = ""
      loading.value = false
      const selected = artifact()
      if (!allowed || !selected) return
      loading.value = true
      try {
        const api = desktop.client()
        const value = await (collection === "activity"
          ? api.sessions.activityScript(request().id, { signal: controller.signal })
          : api.requests.artifact(request().id, selected.kind, { signal: controller.signal }))
        const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer)
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
        if (value.byteLength !== selected.bytes || hash !== selected.sha256)
          throw new LocalizedError("ui.savedContentChangedRefreshItsMetadataBeforeTrying")
        if (!controller.signal.aborted && key.value === identity) record.value = { key: identity, value }
      } catch (cause) {
        if (!controller.signal.aborted && key.value === identity)
          error.value =
            cause instanceof Error || typeof cause === "string"
              ? cause
              : new LocalizedError("ui.savedContentIsUnavailable")
      } finally {
        if (!controller.signal.aborted && key.value === identity) loading.value = false
      }
    },
    { immediate: true },
  )
  return {
    bytes: computed(() => (enabled.value && record.value?.key === key.value ? record.value.value : undefined)),
    loading,
    error,
    retry: () => {
      revision.value++
    },
  }
}
