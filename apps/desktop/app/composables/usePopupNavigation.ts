import type { createNavigationSteps } from "./useNavigationSteps"

/** UI portals share this class through UTheme, including selects inside another popover. */
export function usePopupNavigation(
  navigation: ReturnType<typeof createNavigationSteps>,
  feedback: (open: boolean) => void,
) {
  const popups = new Map<HTMLElement, () => void>()
  let observer: MutationObserver | undefined
  onMounted(() => {
    const feedbackElements =
      '.navigation-popup[data-state="open"], [role="dialog"][data-state="open"]:not(.mobile-sidebar), [role="alertdialog"][data-state="open"]'
    let previous = new Set(document.querySelectorAll(feedbackElements))
    const sync = () => {
      const layers = new Set(document.querySelectorAll(feedbackElements))
      if ([...layers].some((element) => !previous.has(element))) feedback(true)
      else if ([...previous].some((element) => !layers.has(element))) feedback(false)
      previous = layers
      const open = new Set(document.querySelectorAll<HTMLElement>('.navigation-popup[data-state="open"]'))
      for (const [element, stop] of popups)
        if (!open.has(element)) {
          popups.delete(element)
          stop()
        }
      for (const element of open) {
        if (popups.has(element)) continue
        const visible = shallowRef(true)
        let frame = 0
        const dismiss = () => {
          if (!element.isConnected || element.dataset.state !== "open") return
          const layers = [...document.querySelectorAll<HTMLElement>("[data-dismissable-layer]")]
          // A closing select keeps Reka's Escape ownership until its exit animation ends.
          if (layers.slice(layers.indexOf(element) + 1).some((layer) => layer.dataset.state === "closed")) {
            frame = requestAnimationFrame(dismiss)
            return
          }
          element.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }),
          )
        }
        const stopWatch = watch(
          visible,
          (value) => {
            if (!value) dismiss()
          },
          { flush: "sync" },
        )
        const stopStep = navigation.bindModal(visible, false, true)
        popups.set(element, () => {
          cancelAnimationFrame(frame)
          stopWatch()
          stopStep()
        })
      }
    }
    observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    })
    sync()
  })
  onScopeDispose(() => {
    observer?.disconnect()
    for (const stop of popups.values()) stop()
    popups.clear()
  })
}
