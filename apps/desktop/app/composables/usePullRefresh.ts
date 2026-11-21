import { createPullRefresh } from "~/utils/pull-refresh"

export function usePullRefresh(
  viewport: Ref<HTMLElement | null>,
  enabled: () => boolean,
  refresh: () => Promise<void>,
) {
  const distance = shallowRef(0)
  const refreshing = shallowRef(false)
  const gesture = createPullRefresh({
    feedback: (value) => {
      distance.value = value
    },
    refresh: async () => {
      refreshing.value = true
      try {
        await Promise.all([refresh(), new Promise((resolve) => setTimeout(resolve, 500))])
      } finally {
        refreshing.value = false
      }
    },
  })
  useEventListener(
    viewport,
    "touchstart",
    (event: TouchEvent) => {
      const point = event.touches[0],
        root = viewport.value
      let eligible = enabled() && event.touches.length === 1 && !!root && root.scrollTop <= 0
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (!target || target.closest('input,textarea,select,[contenteditable],[role="slider"],[data-no-pull-refresh]'))
        eligible = false
      for (let node = target; node && node !== root; node = node.parentElement ?? undefined) {
        if (node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) eligible = false
      }
      if (point) gesture.start(point.clientX, point.clientY, eligible)
    },
    { passive: true },
  )
  useEventListener(
    viewport,
    "touchmove",
    (event: TouchEvent) => {
      const point = event.touches[0]
      if (!enabled() || event.touches.length !== 1 || !event.cancelable || window.getSelection()?.toString()) {
        gesture.reset()
        return
      }
      if (point && gesture.move(point.clientX, point.clientY)) event.preventDefault()
    },
    { passive: false },
  )
  useEventListener(viewport, "touchend", () => gesture.finish())
  useEventListener(viewport, "touchcancel", () => gesture.finish(true))
  watch(enabled, () => gesture.reset())
  onScopeDispose(gesture.reset)
  return { distance, refreshing, reset: gesture.reset }
}
