import { invoke } from "@tauri-apps/api/core"
import type { Page } from "~/utils/page-history"

interface Step {
  id: number
  page: Page
}
interface BackEvent {
  phase: "start" | "progress" | "cancel" | "commit"
  progress: number
  edge: -1 | 1
}
interface Snapshot {
  header: HTMLElement
  scroll: HTMLElement
  scrollTop: number
}
const eventName = "trawl-predictive-back"

export function useAndroidPredictiveBack(options: {
  enabled: () => boolean
  animate: () => boolean
  workspace: () => HTMLElement | null
  current: () => Step
  previous: () => Step | undefined
  navigate: () => void
}) {
  let dispose = () => {}
  onMounted(() => {
    if (!options.enabled()) return
    const snapshots = new Map<Page, Snapshot>()
    const motion = matchMedia("(prefers-reduced-motion: reduce)")
    let preview: { workspace: HTMLElement; layer: HTMLElement; from: number; to: number; edge: -1 | 1 } | undefined
    let settle: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(settle)
      if (!preview) return
      const { workspace, layer } = preview
      delete workspace.dataset.predictiveBack
      workspace.style.removeProperty("--predictive-back-offset")
      workspace.style.removeProperty("--predictive-back-reveal")
      layer.remove()
      preview = undefined
    }
    const stopCapture = watch(
      options.current,
      (next, previous) => {
        if (next.page === previous.page || !options.animate() || motion.matches) return
        const workspace = options.workspace()
        const header = workspace?.querySelector<HTMLElement>(":scope > .workspace-navbar")
        const scroll = workspace?.querySelector<HTMLElement>(":scope > .workspace-scroll")
        snapshots.delete(previous.page)
        // Large result views can fall back to an ordinary Back without copying a large DOM tree.
        if (!header || !scroll || scroll.querySelectorAll("*").length > 2500) return
        const clone = (element: HTMLElement) => {
          const copy = element.cloneNode(true) as HTMLElement
          for (const embedded of copy.querySelectorAll("iframe, object, embed, audio, video")) embedded.remove()
          for (const identified of copy.querySelectorAll("[id]")) identified.removeAttribute("id")
          return copy
        }
        snapshots.set(previous.page, { header: clone(header), scroll: clone(scroll), scrollTop: scroll.scrollTop })
        if (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value!)
      },
      { flush: "sync" },
    )
    const setProgress = (progress: number) => {
      if (!preview) return
      const fraction = Math.min(1, Math.max(0, progress))
      preview.workspace.style.setProperty("--predictive-back-offset", `${preview.edge * fraction * 100}%`)
      preview.workspace.style.setProperty("--predictive-back-reveal", `${-preview.edge * (1 - fraction) * 22}%`)
    }
    const handleBack = (event: Event) => {
      const { phase, progress, edge } = (event as CustomEvent<BackEvent>).detail
      if (phase === "start") {
        clear()
        if (!options.animate() || motion.matches || document.querySelector('[role="dialog"], [role="menu"]')) return
        const workspace = options.workspace()
        const current = options.current()
        const previous = options.previous()
        if (!workspace || !previous || previous.page === current.page) return
        const snapshot = snapshots.get(previous.page)
        if (!snapshot) return
        const layer = document.createElement("div")
        layer.className = "predictive-back-preview"
        layer.inert = true
        layer.setAttribute("aria-hidden", "true")
        const scroll = snapshot.scroll.cloneNode(true) as HTMLElement
        layer.append(snapshot.header.cloneNode(true), scroll)
        preview = { workspace, layer, from: current.id, to: previous.id, edge }
        setProgress(0)
        workspace.dataset.predictiveBack = "tracking"
        workspace.prepend(layer)
        scroll.scrollTop = snapshot.scrollTop
      } else if (phase === "progress") {
        if (preview && (preview.from !== options.current().id || preview.to !== options.previous()?.id)) clear()
        else setProgress(progress)
      } else if (phase === "cancel") {
        if (!preview) return
        preview.workspace.dataset.predictiveBack = "cancelling"
        setProgress(0)
        settle = setTimeout(clear, 180)
      } else if (phase === "commit") {
        clear()
        options.navigate()
      }
    }
    window.addEventListener(eventName, handleBack)
    window.addEventListener("trawl-background", clear)
    const stopSync = watch(
      () => Boolean(options.previous()),
      (enabled) => void invoke("set_android_page_back", { enabled }).catch(() => {}),
      { immediate: true },
    )
    dispose = () => {
      stopCapture()
      stopSync()
      clear()
      snapshots.clear()
      window.removeEventListener(eventName, handleBack)
      window.removeEventListener("trawl-background", clear)
    }
  })
  onScopeDispose(() => dispose())
}
