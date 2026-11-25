export function closestTabIndex(tabs: readonly Pick<HTMLElement, "offsetLeft" | "offsetWidth">[], center: number) {
  return tabs.reduce((nearest, tab, index) => {
    const previous = tabs[nearest]
    return previous &&
      Math.abs(center - (tab.offsetLeft + tab.offsetWidth / 2)) <
        Math.abs(center - (previous.offsetLeft + previous.offsetWidth / 2))
      ? index
      : nearest
  }, 0)
}

export function useRequestTabDrag(move: (id: string, index: number) => boolean) {
  const feedback = useInteractionFeedback()
  const dragging = shallowRef("")
  const offset = shallowRef(0)
  let press:
    | { id: string; x: number; y: number; element: HTMLElement; pointer: number; grab: number; point: number }
    | undefined
  let hold: ReturnType<typeof setTimeout> | undefined
  let suppressClick = false
  let scrolling = 0
  function cancel() {
    clearTimeout(hold)
    cancelAnimationFrame(scrolling)
    scrolling = 0
    dragging.value = ""
    offset.value = 0
    press = undefined
  }
  function start(event: PointerEvent, id: string) {
    if (event.button !== 0 || !(event.target as Element).closest('[role="tab"]')) return
    cancel()
    suppressClick = false
    const element = event.currentTarget as HTMLElement
    press = {
      id,
      x: event.clientX,
      y: event.clientY,
      element,
      pointer: event.pointerId,
      grab: event.clientX - element.getBoundingClientRect().left,
      point: event.clientX,
    }
    hold = setTimeout(() => {
      if (!press) return
      dragging.value = id
      suppressClick = true
      element.setPointerCapture(event.pointerId)
    }, 300)
  }
  function motion(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointer) return
    if (!dragging.value) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) cancel()
      return
    }
    event.preventDefault()
    press.point = event.clientX
    position()
    if (!scrolling) autoScroll()
  }
  function position(reorder = true) {
    if (!press) return
    const parent = press.element.parentElement
    if (!parent) return
    const tabs = [...parent.querySelectorAll<HTMLElement>(".request-tab")]
    const first = tabs[0],
      last = tabs.at(-1)
    if (!first || !last) return
    const box = parent.getBoundingClientRect()
    const left = Math.max(
      first.offsetLeft,
      Math.min(
        last.offsetLeft + last.offsetWidth - press.element.offsetWidth,
        press.point - box.left + parent.scrollLeft - press.grab,
      ),
    )
    offset.value = left - press.element.offsetLeft
    if (!reorder) return
    const center = left + press.element.offsetWidth / 2
    const index = closestTabIndex(tabs, center)
    if (index !== tabs.indexOf(press.element) && move(press.id, index)) {
      feedback("reorder")
      nextTick(() => {
        position(false)
        if (press?.element.isConnected) press.element.setPointerCapture(press.pointer)
      })
    }
  }
  function autoScroll() {
    scrolling = 0
    if (!press || !dragging.value) return
    const parent = press.element.parentElement
    if (!parent || parent.scrollWidth <= parent.clientWidth + 1) return
    const box = parent.getBoundingClientRect()
    const delta = press.point < box.left + 24 ? -8 : press.point > box.right - 24 ? 8 : 0
    const before = parent.scrollLeft
    parent.scrollLeft = Math.max(0, Math.min(parent.scrollWidth - parent.clientWidth, before + delta))
    if (parent.scrollLeft !== before) {
      position()
      scrolling = requestAnimationFrame(autoScroll)
    }
  }
  function touch(event: TouchEvent) {
    if (dragging.value && event.cancelable) event.preventDefault()
  }

  function end(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointer) return
    if (dragging.value) position()
    cancel()
  }
  function click(event: MouseEvent) {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  onScopeDispose(cancel)
  return { dragging, offset, start, motion, touch, end, cancel, click }
}
