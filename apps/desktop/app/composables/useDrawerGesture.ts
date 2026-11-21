export function scrollDrawerContent(
  node: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  delta: number,
) {
  const before = node.scrollTop
  const next = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, before - delta))
  node.scrollTop = next
  // Consume the intended movement; browser pixel rounding must not claim the drawer gesture.
  return delta - (before - next)
}

export function scrollDrawerGesture<T extends Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">>(
  gesture: { scrolling?: boolean; scroll?: T },
  scrollers: T[],
  delta: number,
) {
  if (!delta) return 0
  gesture.scrolling ??= scrollers.some((node) =>
    delta > 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight,
  )
  if (!gesture.scrolling) return delta
  for (const node of scrollers) {
    const before = node.scrollTop
    delta = scrollDrawerContent(node, delta)
    if (node.scrollTop !== before) gesture.scroll = node
  }
  // A swipe that started scrolling keeps ownership even after reaching either edge.
  return 0
}

export function useDrawerGesture(open: Ref<boolean>) {
  let drag:
    | {
        panel: HTMLElement
        target: HTMLElement
        x: number
        y: number
        distance: number
        moved: boolean
        axis?: "x" | "y"
        scroll?: HTMLElement
        scrolling?: boolean
        at: number
        velocity: number
      }
    | undefined
  let suppressed: HTMLElement | undefined
  let resetTimer: ReturnType<typeof setTimeout> | undefined
  let momentum = 0
  function restore(panel: HTMLElement) {
    panel.style.removeProperty("translate")
    panel.style.removeProperty("transition")
  }
  function start(event: TouchEvent) {
    cancelAnimationFrame(momentum)
    const target = event.target instanceof HTMLElement ? event.target : undefined
    const panel = event.currentTarget as HTMLElement
    if (
      !open.value ||
      event.touches.length !== 1 ||
      !target ||
      target.closest('input,textarea,select,[contenteditable],[role="slider"],[data-vaul-handle],[data-vaul-no-drag]')
    )
      return
    clearTimeout(resetTimer)
    suppressed = undefined
    restore(panel)
    const point = event.touches[0]
    if (!point) return
    drag = {
      panel,
      target,
      x: point.clientX,
      y: point.clientY,
      distance: 0,
      moved: false,
      at: performance.now(),
      velocity: 0,
    }
  }
  function move(event: TouchEvent) {
    if (!drag || event.touches.length !== 1) return
    const point = event.touches[0]
    if (!point) return
    let dy = point.clientY - drag.y
    const dx = point.clientX - drag.x
    if (!drag.axis && (dx || dy)) drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y"
    if (drag.axis !== "y" || !event.cancelable || window.getSelection()?.toString()) return
    // Keep scroll and drawer movement in separate touch gestures.
    event.preventDefault()
    drag.moved ||= Math.abs(dy) > 2
    const now = performance.now()
    drag.velocity = dy / Math.max(1, now - drag.at)
    drag.at = now
    drag.y = point.clientY
    if (drag.distance > 0 && dy < 0) {
      const used = Math.min(drag.distance, -dy)
      drag.distance -= used
      dy += used
    } else if (drag.distance < 0 && dy > 0) {
      const used = Math.min(-drag.distance, dy)
      drag.distance += used
      dy -= used
    }
    if (!drag.distance) {
      const scrollers: HTMLElement[] = []
      for (let node: HTMLElement | null = drag.target; node && node !== drag.panel && dy; node = node.parentElement) {
        if (node.scrollHeight <= node.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(node).overflowY))
          continue
        scrollers.push(node)
      }
      dy = scrollDrawerGesture(drag, scrollers, dy)
    }
    if (Math.abs(dy) < 0.01) dy = 0
    drag.distance = dy >= 0 ? drag.distance + dy : Math.max(-12, drag.distance + dy / 4)
    drag.panel.style.transition = "none"
    drag.panel.style.translate = `0 ${drag.distance}px`
  }
  function glide(element: HTMLElement, velocity: number) {
    let at = performance.now()
    const frame = (now: number) => {
      const elapsed = Math.min(32, now - at)
      at = now
      const before = element.scrollTop
      element.scrollTop -= velocity * elapsed
      velocity *= 0.94 ** (elapsed / 16)
      if (open.value && Math.abs(velocity) > 0.02 && Math.abs(element.scrollTop - before) > 0.2)
        momentum = requestAnimationFrame(frame)
    }
    momentum = requestAnimationFrame(frame)
  }
  function finish(cancelled = false) {
    if (!drag) return
    const { panel, distance, moved, scroll, velocity, at } = drag
    drag = undefined
    if (!moved) {
      restore(panel)
      return
    }
    suppressed = panel
    const dismiss = !cancelled && distance > Math.min(120, panel.clientHeight * 0.25)
    panel.style.transition = "translate 180ms ease-out"
    if (dismiss) open.value = false
    else {
      panel.style.translate = ""
      if (
        !cancelled &&
        !distance &&
        scroll &&
        performance.now() - at < 80 &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        glide(scroll, velocity)
    }
    resetTimer = setTimeout(
      () => {
        restore(panel)
        suppressed = undefined
      },
      dismiss ? 500 : 200,
    )
  }
  function suppress(event: Event) {
    if (!(event.target instanceof Node) || !(drag?.moved || suppressed?.contains(event.target))) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  watch(open, (value) => {
    if (!value) {
      finish(true)
      cancelAnimationFrame(momentum)
    }
  })
  onScopeDispose(() => {
    cancelAnimationFrame(momentum)
    clearTimeout(resetTimer)
    if (drag) restore(drag.panel)
    if (suppressed) restore(suppressed)
  })
  return {
    onTouchstart: start,
    onTouchmove: move,
    onTouchend: () => finish(),
    onTouchcancel: () => finish(true),
    onPointerupCapture: suppress,
    onClickCapture: suppress,
  }
}
