type ScrollPosition = ReturnType<typeof scrollPosition>

function scrollPosition(node: Element, axes: { x: boolean; y: boolean; rtl: boolean }) {
  const width = axes.x ? node.scrollWidth - node.clientWidth : 0
  const height = axes.y ? node.scrollHeight - node.clientHeight : 0
  return {
    x: Math.max(0, Math.min(width, axes.rtl ? -node.scrollLeft : node.scrollLeft)),
    y: Math.max(0, Math.min(height, node.scrollTop)),
    width,
    height,
  }
}

export function reachedEdge(before: number, after: number, extent: number) {
  return extent > 2 && ((before > 1 && after <= 1) || (before < extent - 1 && after >= extent - 1))
}

export function useScrollEdgeFeedback() {
  const desktop = useDesktopStore()
  const feedback = useInteractionFeedback()
  const inputs = new WeakMap<
    Element,
    { time: number; position: ScrollPosition; axes: { x: boolean; y: boolean; rtl: boolean } }
  >()
  let lastPulse = -Infinity
  let cleanup = () => {}
  onMounted(() => {
    if (!desktop.native || !desktop.mobile) return
    const seed = (event: Event) => {
      if (!event.isTrusted || !desktop.config.desktop.hapticFeedback) return
      if (
        event instanceof KeyboardEvent &&
        (!/^(Arrow(?:Up|Down|Left|Right)|PageUp|PageDown|Home|End| )$/.test(event.key) ||
          (event.target instanceof Element &&
            event.target.closest("input, textarea, select, button, [contenteditable]")))
      )
        return
      const time = performance.now()
      for (let node = event.target instanceof Element ? event.target : null; node; node = node.parentElement) {
        if (node.scrollWidth <= node.clientWidth + 2 && node.scrollHeight <= node.clientHeight + 2) continue
        if (event instanceof PointerEvent) {
          const bounds = node.getBoundingClientRect()
          if (
            event.pointerType !== "mouse" ||
            event.target !== node ||
            (event.clientX - bounds.left > 18 &&
              bounds.right - event.clientX > 18 &&
              bounds.bottom - event.clientY > 18)
          )
            continue
        }
        const style = getComputedStyle(node)
        const root = node === document.scrollingElement
        const axes = {
          x: root || /^(auto|scroll|overlay)$/.test(style.overflowX),
          y: root || /^(auto|scroll|overlay)$/.test(style.overflowY),
          rtl: style.direction === "rtl",
        }
        if (axes.x || axes.y) inputs.set(node, { time, axes, position: scrollPosition(node, axes) })
      }
    }
    const scroll = (event: Event) => {
      const node = event.target === document ? document.scrollingElement : event.target
      if (!(node instanceof Element) || node.closest("[inert]")) return
      const input = inputs.get(node)
      const time = performance.now()
      if (!input || time - input.time > 2000) return
      const before = input.position
      const after = scrollPosition(node, input.axes)
      input.position = after
      if (time - lastPulse < 120) return
      if (
        (before.width === after.width && reachedEdge(before.x, after.x, after.width)) ||
        (before.height === after.height && reachedEdge(before.y, after.y, after.height))
      ) {
        lastPulse = time
        feedback("edge")
      }
    }
    const inputEvents = ["wheel", "pointerdown", "touchmove", "keydown"] as const
    for (const event of inputEvents) document.addEventListener(event, seed, { capture: true, passive: true })
    document.addEventListener("scroll", scroll, { capture: true, passive: true })
    cleanup = () => {
      for (const event of inputEvents) document.removeEventListener(event, seed, true)
      document.removeEventListener("scroll", scroll, true)
    }
  })
  onScopeDispose(() => cleanup())
}
