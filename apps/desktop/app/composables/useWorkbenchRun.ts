import { TrawlError } from "@trawl/client"
import { jsonPreview } from "~/utils/json-preview"
import {
  requireWorkbenchCapabilities,
  sendWorkbench,
  type WorkbenchDraft,
  type WorkbenchResult,
} from "~/utils/workbench"

export function useWorkbenchRun() {
  const desktop = useDesktopStore()
  const result = shallowRef<WorkbenchResult>()
  const state = shallowRef<"idle" | "pending" | "completed" | "failed" | "stopped">("idle")
  const error = shallowRef("")
  const failureDetails = shallowRef("")
  const requestId = shallowRef("")
  const requestIdConfirmed = shallowRef(false)
  const elapsed = shallowRef(0)
  let controller: AbortController | undefined
  let generation = 0
  function stop() {
    generation++
    controller?.abort()
    controller = undefined
    if (state.value === "pending") state.value = "stopped"
  }
  async function send(draft: WorkbenchDraft) {
    if (state.value === "pending") return
    stop()
    const current = ++generation
    const id = desktop.activeId
    const abort = new AbortController()
    controller = abort
    result.value = undefined
    requestId.value = ""
    requestIdConfirmed.value = false
    error.value = ""
    failureDetails.value = ""
    state.value = "pending"
    const start = performance.now()
    try {
      requireWorkbenchCapabilities(draft, desktop.capabilities)
      const api = desktop.client((value, proposed) => {
        if (
          current === generation &&
          id === desktop.activeId &&
          (!proposed || desktop.capabilities?.clientRequestIds)
        ) {
          requestId.value = value
          requestIdConfirmed.value = !proposed
        }
      })
      const response = await sendWorkbench(api, JSON.parse(JSON.stringify(draft)), abort.signal)
      if (current !== generation || desktop.activeId !== id) return
      result.value = response
      requestId.value = response.requestId ?? requestId.value
      if (response.requestId) requestIdConfirmed.value = true
      state.value = "completed"
    } catch (cause) {
      if (current !== generation || desktop.activeId !== id) return
      const label =
        cause instanceof TrawlError
          ? cause.kind === "api"
            ? `API error (HTTP ${cause.status})`
            : cause.kind === "network"
              ? "Connection / desktop transport"
              : cause.kind === "timeout"
                ? "Wait timed out"
                : "Response error"
          : "Request validation"
      error.value = `${label}: ${cause instanceof Error ? cause.message.slice(0, 4096) : "Request failed"}`
      if (cause instanceof TrawlError) {
        requestId.value = cause.requestId ?? requestId.value
        if (cause.requestId) requestIdConfirmed.value = true
        const data = cause.data as Record<string, unknown> | undefined
        if (data && typeof data === "object") {
          const details = Object.fromEntries(
            ["timings", "waf", "blockedEvidence", "captchaDiagnostics"]
              .filter((name) => data[name] !== undefined)
              .map((name) => [name, data[name]]),
          )
          if (Object.keys(details).length) failureDetails.value = jsonPreview(details)
        }
      }
      state.value = cause instanceof TrawlError && ["timeout", "aborted"].includes(cause.kind) ? "stopped" : "failed"
    } finally {
      if (current === generation) {
        elapsed.value = Math.round(performance.now() - start)
        controller = undefined
      }
    }
  }
  function reset() {
    stop()
    result.value = undefined
    requestId.value = ""
    requestIdConfirmed.value = false
    error.value = ""
    failureDetails.value = ""
    state.value = "idle"
    elapsed.value = 0
  }
  watch(() => desktop.activeId, reset)
  watch(useDocumentVisibility(), (value) => {
    if (value !== "visible" && !desktop.native) stop()
  })
  onScopeDispose(stop)
  return { result, state, error, failureDetails, requestId, requestIdConfirmed, elapsed, send, stop, reset }
}
