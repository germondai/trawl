const controls =
  'a, button, input, textarea, select, option, label, summary, [contenteditable], [tabindex]:not([role="dialog"]), [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="slider"], [role="separator"], [data-slot="handle"]'

export function isNativeWindowDrag(event: MouseEvent): boolean {
  if (event.button !== 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
    return false
  const target = event.target
  if (
    !(target instanceof Element) ||
    !target.closest("[data-native-window-chrome], .native-sidebar-header, .native-sidebar-body, .native-sidebar-footer")
  )
    return false
  if (target.closest(controls)) return false
  const workspace = target.closest("[data-native-workspace]")
  if (workspace) return target === workspace
  // The scrollbar belongs to an ancestor when the pointer is over one of its children.
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (
      element.scrollHeight > element.clientHeight &&
      ["auto", "scroll"].includes(getComputedStyle(element).overflowY) &&
      event.clientX >= element.getBoundingClientRect().right - 12
    )
      return false
  }
  const text = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  while (text.nextNode()) {
    if (!text.currentNode.textContent?.trim()) continue
    range.selectNodeContents(text.currentNode)
    for (const rect of range.getClientRects()) {
      if (
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom
      )
        return false
    }
  }
  return true
}

export function nativeChromePosition(element: Element | null) {
  const bounds = element?.getBoundingClientRect()
  return bounds?.width ? { x: bounds.left + 1, centerY: bounds.top + bounds.height / 2 } : null
}
