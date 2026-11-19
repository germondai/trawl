type Tween = { value: number; from: number; to: number; start: number }
type Thumb = { inset: Tween; alpha: Tween }

export function useCustomScrollbars() {
  const reducedMotion = usePreferredReducedMotion()
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
  const thumbs = new Map<HTMLElement, Thumb>()
  const moving = new Set<HTMLElement>()
  const hovered = new Set<HTMLElement>()
  let frame = 0
  let probe: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  let removals: MutationObserver | undefined
  const overlay = () => document.documentElement.hasAttribute("data-auto-scrollbars")
  const tween = (value: number): Tween => ({ value, from: value, to: value, start: 0 })
  function paint(element: HTMLElement, thumb: Thumb) {
    element.style.setProperty("--trawl-scrollbar-inset", `${thumb.inset.value}px`)
    element.style.setProperty("--trawl-scrollbar-alpha", String(thumb.alpha.value))
  }
  function animate(now: number) {
    frame = 0
    for (const element of moving) {
      const thumb = thumbs.get(element)!
      let done = true
      for (const value of [thumb.inset, thumb.alpha]) {
        const progress = reducedMotion.value === "reduce" ? 1 : Math.max(0, Math.min(1, (now - value.start) / 160))
        value.value = value.from + (value.to - value.from) * (1 - (1 - progress) ** 3)
        if (progress < 1 && value.from !== value.to) done = false
      }
      paint(element, thumb)
      if (done) moving.delete(element)
    }
    if (moving.size) frame = requestAnimationFrame(animate)
  }
  function set(element: HTMLElement, values: { inset?: number; alpha?: number }) {
    const thumb = thumbs.get(element) ?? { inset: tween(3), alpha: tween(overlay() ? 0 : 0.5) }
    thumbs.set(element, thumb)
    let changed = false
    for (const key of ["inset", "alpha"] as const) {
      const to = values[key]
      if (to === undefined || to === thumb[key].to) continue
      thumb[key] = { value: thumb[key].value, from: thumb[key].value, to, start: performance.now() }
      changed = true
    }
    if (changed) moving.add(element)
    if (moving.size && !frame) frame = requestAnimationFrame(animate)
  }
  const preference = () => {
    if (!probe) return
    document.documentElement.toggleAttribute("data-auto-scrollbars", probe.offsetWidth === probe.clientWidth)
    for (const element of thumbs.keys())
      set(element, { alpha: hovered.has(element) ? 0.9 : overlay() && !timers.has(element) ? 0 : 0.5 })
  }
  const show = (element: HTMLElement) => {
    clearTimeout(timers.get(element))
    element.dataset.scrollActive = ""
    set(element, { alpha: hovered.has(element) ? 0.9 : 0.5 })
    timers.set(
      element,
      setTimeout(() => {
        element.removeAttribute("data-scroll-active")
        timers.delete(element)
        set(element, { alpha: hovered.has(element) ? 0.9 : overlay() ? 0 : 0.5 })
      }, 1200),
    )
  }
  function unhover(except = new Set<HTMLElement>()) {
    for (const element of hovered)
      if (!except.has(element)) {
        hovered.delete(element)
        set(element, { inset: 3, alpha: overlay() && !timers.has(element) ? 0 : 0.5 })
      }
  }
  useEventListener(
    document,
    "scroll",
    (event) => {
      const element = event.target === document ? document.scrollingElement : event.target
      if (element instanceof HTMLElement) show(element)
    },
    { capture: true, passive: true },
  )
  useEventListener(
    document,
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse") return
      const next = new Set<HTMLElement>()
      let element = event.target instanceof HTMLElement ? event.target : undefined
      while (element) {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (
          (element.scrollHeight > element.clientHeight &&
            /auto|scroll/.test(style.overflowY) &&
            event.clientX >= rect.right - 12) ||
          (element.scrollWidth > element.clientWidth &&
            /auto|scroll/.test(style.overflowX) &&
            event.clientY >= rect.bottom - 12)
        )
          next.add(element)
        element = element.parentElement ?? undefined
      }
      unhover(next)
      for (const item of next) {
        hovered.add(item)
        set(item, { inset: 1 })
        show(item)
      }
    },
    { passive: true },
  )
  useEventListener(
    document,
    "pointerout",
    (event) => {
      if (!event.relatedTarget) unhover()
    },
    { passive: true },
  )
  useEventListener(window, "blur", () => unhover())
  useEventListener(window, "focus", preference)
  useEventListener(window, "resize", preference)
  onMounted(() => {
    probe = document.createElement("div")
    probe.dataset.nativeScrollbar = ""
    probe.setAttribute("aria-hidden", "true")
    probe.style.cssText =
      "position:fixed;left:-100px;top:-100px;width:50px;height:50px;overflow:scroll;visibility:hidden;pointer-events:none"
    document.body.append(probe)
    observer = new ResizeObserver(preference)
    observer.observe(probe)
    removals = new MutationObserver((records) => {
      if (!records.some((record) => record.removedNodes.length)) return
      for (const element of thumbs.keys())
        if (!element.isConnected) {
          clearTimeout(timers.get(element))
          timers.delete(element)
          thumbs.delete(element)
          moving.delete(element)
          hovered.delete(element)
          element.removeAttribute("data-scroll-active")
          element.style.removeProperty("--trawl-scrollbar-inset")
          element.style.removeProperty("--trawl-scrollbar-alpha")
        }
    })
    removals.observe(document.body, { childList: true, subtree: true })
    preference()
  })
  onScopeDispose(() => {
    cancelAnimationFrame(frame)
    observer?.disconnect()
    removals?.disconnect()
    probe?.remove()
    document.documentElement.removeAttribute("data-auto-scrollbars")
    for (const [element, timer] of timers) {
      clearTimeout(timer)
      element.removeAttribute("data-scroll-active")
    }
    for (const element of thumbs.keys()) {
      element.style.removeProperty("--trawl-scrollbar-inset")
      element.style.removeProperty("--trawl-scrollbar-alpha")
    }
    timers.clear()
    thumbs.clear()
    moving.clear()
    hovered.clear()
  })
}
