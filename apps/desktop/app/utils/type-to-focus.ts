export function typeToFocus(event: KeyboardEvent, root: HTMLElement) {
  const document = root.ownerDocument
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    [...event.key].length !== 1 ||
    event.key.trim() === "" ||
    (document.activeElement !== document.body && document.activeElement !== document.documentElement) ||
    document.getSelection()?.toString()
  )
    return
  const input = root.querySelector<HTMLInputElement>("input[data-type-focus], [data-type-focus] input")
  if (!input || input.matches(":disabled") || input.readOnly || !input.getClientRects().length) return
  input.focus({ preventScroll: true })
  if (document.activeElement !== input) return
  event.preventDefault()
  // URL inputs do not support setRangeText or selectionStart.
  input.value += event.key
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
