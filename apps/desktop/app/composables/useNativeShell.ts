import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isNativeWindowDrag, nativeChromePosition } from "~/utils/native-window-drag"

export function useNativeShell() {
  const desktop = useDesktopStore()
  let disposed = false
  let observer: ResizeObserver | undefined
  let documentId: number | undefined
  let sending = false
  let queued = false
  const position = () => nativeChromePosition(document.querySelector("[data-native-controls]"))
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
      if (!disposed) console.warn("Could not align window controls", error)
    } finally {
      sending = false
    }
  }
  const schedule = () => {
    void update()
  }
  function drag(event: MouseEvent) {
    if (!isNativeWindowDrag(event)) return
    event.preventDefault()
    void getCurrentWindow()
      .startDragging()
      .catch((error) => console.warn("Could not move the window", error))
  }
  onMounted(async () => {
    if (!desktop.native) return
    try {
      documentId = await invoke<number>("native_window_document")
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
      if (!disposed) desktop.error = `Could not prepare window: ${String(error)}`
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
