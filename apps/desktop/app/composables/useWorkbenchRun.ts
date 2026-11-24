import { TrawlError } from "@trawl/client"
import { computed } from "vue"
import { jsonPreview } from "~/utils/json-preview"
import {
  requireWorkbenchCapabilities,
  sendWorkbench,
  type WorkbenchDraft,
  type WorkbenchResult,
} from "~/utils/workbench"
import { nativeErrorMessage, t } from "../utils/localization"
import { useInteractionFeedback } from "./useInteractionFeedback"

export function useWorkbenchRun() {
  const desktop = useDesktopStore()
  const feedback = useInteractionFeedback()
  const result = shallowRef<WorkbenchResult>()
  const state = shallowRef<"idle" | "pending" | "completed" | "failed" | "stopped">("idle")
  const failure = shallowRef<unknown>()
  const error = computed(() => {
    const cause = failure.value
    if (cause === undefined) return ""
    const label =
      cause instanceof TrawlError
        ? cause.kind === "api"
          ? t("ui.apiErrorHttp", { p0: cause.status })
          : cause.kind === "network"
            ? t("ui.connectionDesktopTransport")
            : cause.kind === "timeout"
              ? t("ui.waitTimedOut")
              : t("ui.responseError")
        : t("ui.requestValidation")
    return t("errors.requestDetails", {
      label,
      error: nativeErrorMessage(cause).slice(0, 4096) || t("ui.requestFailed"),
    })
  })
  const failureDetails = shallowRef("")
  const requestId = shallowRef("")
  const requestIdConfirmed = shallowRef(false)
  const elapsed = shallowRef(0)
  let controller: AbortController | undefined
  let generation = 0
  let started = 0
  let timer: ReturnType<typeof setInterval> | undefined
  function finishTimer() {
    if (timer !== undefined) elapsed.value = Math.round(performance.now() - started)
    clearInterval(timer)
    timer = undefined
  }
  function stop() {
    finishTimer()
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
    failure.value = undefined
    failureDetails.value = ""
    state.value = "pending"
    feedback("press")
    started = performance.now()
    elapsed.value = 0
    timer = setInterval(() => {
      elapsed.value = Math.round(performance.now() - started)
    }, 100)
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
      feedback("success")
    } catch (cause) {
      if (current !== generation || desktop.activeId !== id) return
      failure.value = cause
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
      if (!(cause instanceof TrawlError && cause.kind === "aborted")) feedback("error")
    } finally {
      if (current === generation) {
        finishTimer()
        controller = undefined
      }
    }
  }
  function reset() {
    stop()
    result.value = undefined
    requestId.value = ""
    requestIdConfirmed.value = false
    failure.value = undefined
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
