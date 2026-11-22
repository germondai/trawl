import { invoke } from "@tauri-apps/api/core"
import { isNativeWindowDrag, nativeChromePosition } from "~/utils/native-window-drag"
import { LocalizedError, nativeErrorMessage } from "../utils/localization"

export function useNativeShell(sidebarOpen: Readonly<Ref<boolean>>, initializing: Readonly<Ref<boolean>>) {
  const desktop = useDesktopStore()
  let disposed = false
  let observer: ResizeObserver | undefined
  let documentId: number | undefined
  let clock: { earliest: number; latest: number } | undefined
  let sending = false
  let queued = false
  const position = () => {
    const target = nativeChromePosition(document.querySelector("[data-native-controls]"))
    return target && { ...target, hidden: sidebarOpen.value && !window.matchMedia("(min-width: 1024px)").matches }
  }
  async function update() {
    if (disposed || documentId === undefined) return
    if (sending) {
      queued = true
      return
    }
    sending = true
    try {
      do {
        queued = false
        const target = position()
        if (target) await invoke("native_window_chrome", { documentId, position: target })
      } while (queued && !disposed)
    } catch (error) {
      if (!disposed) console.warn(t("ui.couldNotAlignWindowControls"), error)
    } finally {
      sending = false
    }
  }
  const schedule = () => {
    void update()
  }
  watch(sidebarOpen, schedule, { flush: "post" })
  function drag(event: MouseEvent) {
    if (documentId === undefined || !isNativeWindowDrag(event)) return
    event.preventDefault()
    const timestamp = clock && {
      earliest: clock.earliest + event.timeStamp / 1000,
      latest: clock.latest + event.timeStamp / 1000,
    }
    void invoke("native_window_drag", { documentId, timestamp }).catch((error) =>
      console.warn(t("ui.couldNotMoveTheWindow"), error),
    )
  }
  onMounted(async () => {
    if (!desktop.native || desktop.mobile) return
    try {
      // WebKit's DOM event and NSEvent timestamps share the macOS monotonic clock.
      for (let sample = 0; sample < 3; sample++) {
        const before = performance.now() / 1000
        const document = await invoke<{ documentId: number; monotonicTime: number | null }>("native_window_document")
        const after = performance.now() / 1000
        documentId = document.documentId
        if (document.monotonicTime === null) break
        const next = {
          earliest: document.monotonicTime - after - 0.001,
          latest: document.monotonicTime - before + 0.001,
        }
        if (!clock || next.latest - next.earliest < clock.latest - clock.earliest) clock = next
      }
      await until(() => desktop.preferencesReady && !initializing.value).toBe(true)
      await document.fonts.ready
      const logo = document.querySelector<HTMLImageElement>(".brand img")
      if (logo) await logo.decode().catch(() => {})
      await nextTick()
      if (disposed) return
      // Hidden WKWebViews may pause animation frames and resize observer delivery.
      const target = position()
      if (target) await invoke("native_window_chrome", { documentId, position: target })
      await invoke("native_window_ready", { documentId })
      if (disposed) return
      observer = new ResizeObserver(schedule)
      for (const node of document.querySelectorAll("[data-native-controls], .workspace-navbar")) observer.observe(node)
      window.addEventListener("resize", schedule)
      document.addEventListener("mousedown", drag)
    } catch (error) {
      if (!disposed)
        desktop.setError(
          new LocalizedError("ui.couldNotPrepareWindow", {
            get p0() {
              return nativeErrorMessage(error)
            },
          }),
        )
    }
  })
  const cleanup = () => {
    disposed = true
    observer?.disconnect()
    window.removeEventListener("resize", schedule)
    document.removeEventListener("mousedown", drag)
  }
  onBeforeUnmount(cleanup)
  import.meta.hot?.dispose(cleanup)
}
