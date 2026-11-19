import Lenis from "lenis"
import type { InjectionKey, Ref } from "vue"

export const scrollWorkspaceToTop: InjectionKey<(smooth?: boolean) => void> = Symbol("workspace-scroll")

export function useWorkspaceScroll(viewport: Readonly<Ref<HTMLElement | null>>) {
  const reducedMotion = usePreferredReducedMotion()
  const desktop = useDesktopStore()
  type Axis = "vertical" | "horizontal"
  type Engine = { lenis: Lenis; axis: Axis; clock: number; previousFrame: number }
  const engines = new Map<HTMLElement, Engine>()
  const active = new Set<Engine>()
  const targets = new WeakMap<Event, HTMLElement>()
  let frame = 0
  let enabled = false
  const animate = (time: number) => {
    frame = 0
    for (const engine of active) {
      engine.clock += engine.previousFrame ? Math.min(64, time - engine.previousFrame) : 16
      engine.previousFrame = time
      engine.lenis.raf(engine.clock)
      if (engine.lenis.isScrolling !== "smooth") {
        active.delete(engine)
        engine.previousFrame = 0
      }
    }
    if (active.size) frame = requestAnimationFrame(animate)
  }
  const wake = (engine: Engine) => {
    if (document.hidden) return
    active.add(engine)
    if (!frame) frame = requestAnimationFrame(animate)
  }
  const destroy = (element: HTMLElement) => {
    const engine = engines.get(element)
    if (!engine) return
    active.delete(engine)
    engine.lenis.destroy()
    engines.delete(element)
  }
  const engineFor = (wrapper: HTMLElement, axis: Axis) => {
    if (engines.get(wrapper)?.axis !== axis) destroy(wrapper)
    const existing = engines.get(wrapper)
    if (existing) {
      const dimensions = existing.lenis.dimensions
      if (dimensions.scrollHeight !== wrapper.scrollHeight || dimensions.scrollWidth !== wrapper.scrollWidth)
        existing.lenis.resize()
      return existing
    }
    const engine: Engine = {
      axis,
      clock: 0,
      previousFrame: 0,
      lenis: new Lenis({
        wrapper,
        content: (wrapper.firstElementChild as HTMLElement | null) ?? wrapper,
        orientation: axis,
        autoRaf: false,
        smoothWheel: true,
        syncTouch: false,
        lerp: 0.14,
        allowNestedScroll: true,
        virtualScroll: ({ event }) => !event.type.includes("wheel") || targets.get(event) === wrapper,
      }),
    }
    engine.lenis.on("virtual-scroll", () => wake(engine))
    engines.set(wrapper, engine)
    return engine
  }
  function wheel(event: WheelEvent) {
    if (event.ctrlKey || event.defaultPrevented || document.hidden) return
    const axis: Axis = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "horizontal" : "vertical"
    const delta = axis === "horizontal" ? event.deltaX || event.deltaY : event.deltaY
    if (!delta) return
    for (const node of event.composedPath()) {
      if (!(node instanceof HTMLElement)) continue
      if (node.matches("[data-lenis-prevent],[data-lenis-prevent-wheel]")) return
      const style = getComputedStyle(node)
      const horizontal = axis === "horizontal"
      const overflow = horizontal ? style.overflowX : style.overflowY
      const limit = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight
      if (!/^(auto|scroll)$/.test(overflow) || limit < 1) continue
      const position = horizontal ? node.scrollLeft : node.scrollTop
      const overscroll = horizontal ? style.overscrollBehaviorX : style.overscrollBehaviorY
      if ((delta < 0 ? position <= 0 : position >= limit - 1) && !["contain", "none"].includes(overscroll)) continue
      targets.set(event, node)
      engineFor(node, axis)
      return
    }
  }
  const top = (smooth = true) => {
    const wrapper = viewport.value
    if (!wrapper) return
    if (enabled) {
      const engine = engineFor(wrapper, "vertical")
      engine.lenis.resize()
      engine.lenis.scrollTo(0, { immediate: !smooth, duration: 0.45, force: true, onStart: () => wake(engine) })
    } else wrapper.scrollTo({ top: 0, behavior: smooth && reducedMotion.value !== "reduce" ? "smooth" : "instant" })
  }
  provide(scrollWorkspaceToTop, top)
  watch(
    [reducedMotion, () => desktop.config.desktop.smoothScroll],
    ([motion, smooth], _, onCleanup) => {
      enabled = motion !== "reduce" && smooth
      if (!enabled) return
      // Capture selects the nearest scrollable before its Lenis listener, including portals.
      document.addEventListener("wheel", wheel, { capture: true, passive: true })
      const observer = new MutationObserver(() => {
        for (const element of engines.keys()) if (!element.isConnected) destroy(element)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      onCleanup(() => {
        enabled = false
        document.removeEventListener("wheel", wheel, true)
        observer.disconnect()
        cancelAnimationFrame(frame)
        frame = 0
        for (const element of engines.keys()) destroy(element)
      })
    },
    { immediate: true, flush: "post" },
  )
  useEventListener(document, "visibilitychange", () => {
    if (!document.hidden) return
    cancelAnimationFrame(frame)
    frame = 0
    for (const engine of active) {
      engine.lenis.scrollTo(engine.lenis.actualScroll, { immediate: true, force: true })
      engine.previousFrame = 0
    }
    active.clear()
  })
  return { top }
}
