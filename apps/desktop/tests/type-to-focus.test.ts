import { expect, test } from "bun:test"
import { typeToFocus } from "../app/utils/type-to-focus"

function fixture() {
  const body = {},
    document = { body, documentElement: {}, activeElement: body, getSelection: () => null }
  let updates = 0
  const input = {
    value: "",
    disabled: false,
    disabledByFieldset: false,
    matches: () => input.disabled || input.disabledByFieldset,
    readOnly: false,
    getClientRects: () => [1],
    focus: () => {
      document.activeElement = input
    },
    dispatchEvent: () => {
      updates++
    },
  }
  const root = { ownerDocument: document, querySelector: () => input } as unknown as HTMLElement
  return { document, input, root, updates: () => updates }
}
function key(value = "a", extra = {}) {
  return {
    key: value,
    defaultPrevented: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...extra,
  } as KeyboardEvent
}

test("idle typing focuses the page input and includes the first character in its model update", () => {
  const f = fixture(),
    event = key("Ž")
  f.input.value = "https://"
  typeToFocus(event, f.root)
  expect(f.document.activeElement).toBe(f.input)
  expect(f.input.value).toBe("https://Ž")
  expect(f.updates()).toBe(1)
  expect(event.defaultPrevented).toBe(true)
})

test("typing never steals focus from an active control or intercepts shortcuts/composition", () => {
  for (const event of [
    key("Enter"),
    key(" "),
    key("a", { ctrlKey: true }),
    key("a", { metaKey: true }),
    key("a", { altKey: true }),
    key("a", { isComposing: true }),
    key("a", { defaultPrevented: true }),
  ]) {
    const f = fixture()
    typeToFocus(event, f.root)
    expect(f.updates()).toBe(0)
  }
  const f = fixture()
  f.document.activeElement = {}
  typeToFocus(key(), f.root)
  expect(f.updates()).toBe(0)
  f.document.activeElement = f.document.body
  f.input.disabled = true
  typeToFocus(key(), f.root)
  expect(f.updates()).toBe(0)
  f.input.disabled = false
  f.input.disabledByFieldset = true
  typeToFocus(key(), f.root)
  expect(f.updates()).toBe(0)
})
