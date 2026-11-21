export type HistoryDirection = "back" | "forward"
export type HistoryGesturePhase = "begin" | "end" | "cancel" | "momentum" | "momentum-end"

interface HistoryGestureOptions {
  enabled(): boolean
  canNavigate(direction: HistoryDirection): boolean
  navigate(direction: HistoryDirection): void
}

type WheelInput = Pick<
  WheelEvent,
  "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented"
>

export function createHistoryGesture(
  options: HistoryGestureOptions & {
    feedback(direction: HistoryDirection | null, progress: number): void
  },
) {
  let gesture: { blocked: boolean; x: number } | undefined
  let touching = false,
    momentum = false,
    owned = false
  const neutralZone = 28,
    threshold = 90
  const finish = (cancelled = false) => {
    const movement = gesture?.blocked ? 0 : (gesture?.x ?? 0)
    gesture = undefined
    const direction = movement < 0 ? "back" : "forward"
    if (
      !cancelled &&
      Math.abs(movement) >= neutralZone + threshold &&
      options.enabled() &&
      options.canNavigate(direction)
    ) {
      options.navigate(direction)
    }
    options.feedback(null, 0)
  }
  const reset = () => {
    gesture = undefined
    touching = momentum = owned = false
    options.feedback(null, 0)
  }
  return {
    reset,
    phase(phase: HistoryGesturePhase) {
      if (phase === "begin") {
        // The first DOM wheel can arrive before its native begin notification.
        if (touching || momentum || !gesture) {
          gesture = undefined
          owned = false
        }
        touching = true
        momentum = false
      } else if (phase === "end" || phase === "cancel") {
        touching = false
        momentum = true
        finish(phase === "cancel")
      } else if (phase === "momentum") momentum = true
      else if (phase === "momentum-end") momentum = owned = false
    },
    idle() {
      if (touching) return
      if (!momentum) finish()
      momentum = owned = false
    },
    wheel(event: WheelInput, blockedAtStart: () => boolean): boolean {
      if (momentum) return owned
      if (
        !options.enabled() ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.deltaMode !== 0
      ) {
        gesture ??= { blocked: true, x: 0 }
        gesture.blocked = true
        options.feedback(null, 0)
        return owned
      }
      gesture ??= { blocked: blockedAtStart() || Math.abs(event.deltaY) > Math.abs(event.deltaX), x: 0 }
      if (event.defaultPrevented) gesture.blocked = true
      if (gesture.blocked || (!owned && Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.5)) return owned
      gesture.x = Math.max(-neutralZone - threshold, Math.min(neutralZone + threshold, gesture.x + event.deltaX))
      const direction = gesture.x < 0 ? "back" : "forward"
      const progress = Math.min(1, Math.max(0, (Math.abs(gesture.x) - neutralZone) / threshold))
      if (options.canNavigate(direction)) owned = true
      if (!options.canNavigate(direction) || progress === 0) {
        options.feedback(direction, 0)
        return owned
      }
      owned = true
      options.feedback(direction, progress)
      return true
    },
  }
}

export function installNativeHistoryGesture(options: HistoryGestureOptions) {
  let feedback: HTMLElement | undefined
  let animation: Animation | undefined
  let geometry: ResizeObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const removeFeedback = () => {
    geometry?.disconnect()
    geometry = undefined
    if (animation) {
      void animation.finished.catch(() => {})
      animation.cancel()
    }
    animation = undefined
    feedback?.remove()
    feedback = undefined
  }
  const position = () => {
    if (!feedback) return
    const workspace = document.querySelector("[data-native-workspace]")
    const panel = document.fullscreenElement ?? workspace?.firstElementChild ?? workspace
    const bounds = panel?.getBoundingClientRect()
    const back = feedback.dataset.direction === "back"
    feedback.style.left = back ? `${(bounds?.left ?? 0) + 12}px` : "auto"
    feedback.style.right = back ? "auto" : `${window.innerWidth - (bounds?.right ?? window.innerWidth) + 12}px`
    feedback.style.top = `${(bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2}px`
  }
  const gesture = createHistoryGesture({
    ...options,
    feedback(direction, progress) {
      if (direction === null) {
        if (!feedback || animation) return
        const element = feedback
        animation = element.animate?.([{ opacity: element.style.opacity }, { opacity: 0 }], {
          duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180,
          fill: "forwards",
        })
        if (animation)
          animation.onfinish = () => {
            if (feedback === element) removeFeedback()
          }
        else removeFeedback()
        return
      }
      if (!feedback && progress === 0) return
      if (animation) removeFeedback()
      if (!feedback) {
        feedback = document.createElement("div")
        feedback.className = "native-history-gesture"
        feedback.setAttribute("aria-hidden", "true")
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
        svg.setAttribute("viewBox", "0 0 24 24")
        svg.setAttribute("fill", "none")
        svg.setAttribute("stroke", "currentColor")
        svg.setAttribute("stroke-width", "2")
        svg.setAttribute("stroke-linecap", "round")
        svg.setAttribute("stroke-linejoin", "round")
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
        path.setAttribute("d", "m15 18-6-6 6-6")
        svg.append(path)
        feedback.append(svg)
        ;(document.fullscreenElement ?? document.body).append(feedback)
        geometry = new ResizeObserver(position)
        const panel = document.querySelector("[data-native-workspace]")
        if (panel) geometry.observe(panel)
      }
      feedback.dataset.direction = direction
      feedback.style.opacity = String(progress)
      feedback.style.setProperty("--gesture-progress", String(progress))
      position()
    },
  })
  const blockedAt = (target: EventTarget | null) => {
    if (
      !(target instanceof Element) ||
      target.closest(
        'input,textarea,select,[contenteditable],iframe,[role="slider"],[role="menu"],[role="listbox"],[aria-roledescription="carousel"],[data-no-history-gesture]',
      )
    )
      return true
    for (let node: Element | null = target; node; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true
    }
    return false
  }
  const settle = () => {
    clearTimeout(timer)
    timer = setTimeout(() => gesture.idle(), 180)
  }
  const wheel = (event: WheelEvent) => {
    if (gesture.wheel(event, () => blockedAt(event.target))) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    settle()
  }
  const reset = () => {
    clearTimeout(timer)
    gesture.reset()
    removeFeedback()
  }
  // Claim navigation before native scrolling or a descendant Lenis listener can claim the wheel.
  window.addEventListener("wheel", wheel, { passive: false, capture: true })
  window.addEventListener("blur", reset)
  return {
    phase(phase: HistoryGesturePhase) {
      clearTimeout(timer)
      gesture.phase(phase)
      if (phase !== "begin") settle()
    },
    dispose() {
      reset()
      window.removeEventListener("wheel", wheel, true)
      window.removeEventListener("blur", reset)
    },
  }
}
