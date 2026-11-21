export const useTooltipLifecycle = createSharedComposable(() => {
  const hover = useMediaQuery("(hover: hover) and (pointer: fine)")
  const visibility = useDocumentVisibility()
  const keyboard = shallowRef(false)
  const opened = new Set<() => void>()
  const dismiss = () => {
    for (const close of [...opened]) close()
  }
  const register = (close: () => void) => {
    opened.add(close)
    return () => opened.delete(close)
  }
  useEventListener(
    document,
    "pointerdown",
    () => {
      keyboard.value = false
      dismiss()
    },
    { capture: true },
  )
  useEventListener(
    document,
    "keydown",
    (event: KeyboardEvent) => {
      if (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) keyboard.value = true
      dismiss()
    },
    { capture: true },
  )
  useEventListener(document, "click", dismiss, { capture: true })
  useEventListener(document, "scroll", dismiss, { capture: true, passive: true })
  useEventListener(window, "blur", dismiss)
  useEventListener(window, "trawl-background", dismiss)
  watch(visibility, dismiss)
  return {
    visible: computed(() => visibility.value === "visible"),
    enabled: computed(() => visibility.value === "visible" && (hover.value || keyboard.value)),
    register,
    dismiss,
  }
})
