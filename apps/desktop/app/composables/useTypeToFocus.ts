import { typeToFocus } from "~/utils/type-to-focus"

export function useTypeToFocus(root: Ref<HTMLElement | null>) {
  useEventListener(document, "keydown", (event: KeyboardEvent) => {
    if (!root.value || document.querySelector('[role="dialog"], [role="menu"], [data-shortcut-recording]')) return
    typeToFocus(event, root.value)
  })
}
