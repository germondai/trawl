import { expect, test } from "bun:test"
import { shallowRef } from "vue"
import { createNavigationSteps } from "../app/composables/useNavigationSteps"

const move = (navigation: ReturnType<typeof createNavigationSteps>, direction: -1 | 1) => {
  const target = navigation.peek(direction)
  if (target) navigation.go(target.id)
}

test("settings selections are individual steps and survive page Back/Forward without changing values", () => {
  const navigation = createNavigationSteps()
  navigation.visit("settings")
  const category = shallowRef("general")
  let stop = navigation.bindSelection("category", category)
  category.value = "browser"
  category.value = "history"
  move(navigation, -1)
  expect(category.value).toBe("browser")
  move(navigation, 1)
  expect(category.value).toBe("history")
  stop()
  navigation.visit("resources")
  move(navigation, -1)
  const restored = shallowRef("general")
  stop = navigation.bindSelection("category", restored)
  expect(restored.value).toBe("history")
  move(navigation, -1)
  expect(restored.value).toBe("browser")
  stop()
})

test("Back closes only the top modal; Forward reopens it, and explicit confirmation forgets it", () => {
  const navigation = createNavigationSteps()
  navigation.visit("resources")
  const modal = shallowRef<string>()
  const stop = navigation.bindModal(modal, undefined)
  modal.value = "captures"
  expect(navigation.current.value.modals).toHaveLength(1)
  move(navigation, -1)
  expect(modal.value).toBeUndefined()
  expect(navigation.current.value.page).toBe("resources")
  expect(navigation.canForward.value).toBe(true)
  move(navigation, 1)
  expect(modal.value).toBe("captures")
  modal.value = undefined
  expect(navigation.current.value.modals).toEqual([])
  expect(navigation.canForward.value).toBe(false)
  move(navigation, -1)
  expect(navigation.current.value.page).toBe("overview")
  stop()
})

test("nested dialogs and tabs inside them unwind in order", () => {
  const navigation = createNavigationSteps()
  const outer = shallowRef(false),
    inner = shallowRef(false),
    tab = shallowRef("headers")
  const stopOuter = navigation.bindModal(outer, false)
  const stopInner = navigation.bindModal(inner, false)
  outer.value = true
  const stopTab = navigation.bindSelection("inspector", tab, { transient: true })
  tab.value = "preview"
  inner.value = true
  move(navigation, -1)
  expect([outer.value, inner.value, tab.value]).toEqual([true, false, "preview"])
  move(navigation, -1)
  expect([outer.value, inner.value, tab.value]).toEqual([true, false, "headers"])
  move(navigation, -1)
  expect(outer.value).toBe(false)
  stopTab()
  stopInner()
  stopOuter()
})

test("disposed dialogs cannot reopen from stale history and new navigation drops Forward", () => {
  const navigation = createNavigationSteps()
  const open = shallowRef(false)
  const stop = navigation.bindModal(open, false)
  open.value = true
  move(navigation, -1)
  stop()
  expect(navigation.canForward.value).toBe(false)
  navigation.visit("settings")
  navigation.visit("browser")
  move(navigation, -1)
  navigation.visit("resources")
  expect(navigation.canForward.value).toBe(false)
  expect(navigation.current.value.page).toBe("resources")
})

test("closed request tabs are removed from history without resurrecting their draft", () => {
  const navigation = createNavigationSteps("workbench")
  const allowed = new Set(["one", "two"]),
    tab = shallowRef("one")
  const stop = navigation.bindSelection("draft", tab, { valid: (value) => allowed.has(value) })
  tab.value = "two"
  tab.value = "one"
  allowed.delete("one")
  tab.value = "two"
  navigation.dropSelection("draft", "one", "two")
  expect(navigation.canBack.value).toBe(false)
  expect(tab.value).toBe("two")
  stop()
})

test("navigation snapshots stay bounded and contain UI state rather than modal payloads", () => {
  const navigation = createNavigationSteps()
  const data = shallowRef<{ secret: string }>()
  const stop = navigation.bindModal(data, undefined)
  data.value = { secret: "owned-private-payload" }
  expect(JSON.stringify(navigation.current.value)).not.toContain("owned-private")
  data.value = undefined
  const tab = shallowRef("0")
  const stopTab = navigation.bindSelection("tab", tab)
  for (let i = 1; i <= 200; i++) tab.value = String(i)
  let count = 0
  while (navigation.canBack.value) {
    move(navigation, -1)
    count++
  }
  expect(count).toBe(127)
  navigation.reset()
  expect(navigation.canForward.value).toBe(false)
  stopTab()
  stop()
})

test("a discard confirmation preserves a requested Forward destination", () => {
  const navigation = createNavigationSteps()
  const confirm = shallowRef(false)
  const stop = navigation.bindModal(confirm, false)
  navigation.visit("settings")
  navigation.visit("resources")
  move(navigation, -1)
  const destination = navigation.peek(1)!.id
  confirm.value = true
  expect(navigation.find(destination)?.page).toBe("resources")
  confirm.value = false
  navigation.go(destination)
  expect(navigation.current.value.page).toBe("resources")
  stop()
})

test("a modal's tab Forward steps survive its content unmounting on Back", () => {
  const navigation = createNavigationSteps()
  const open = shallowRef(false)
  const stopModal = navigation.bindModal(open, false)
  open.value = true
  let tab = shallowRef("headers")
  let stopTab = navigation.bindSelection("inspector", tab, { transient: true })
  tab.value = "payload"
  move(navigation, -1)
  move(navigation, -1)
  stopTab()
  expect(open.value).toBe(false)
  move(navigation, 1)
  expect(open.value).toBe(true)
  tab = shallowRef("headers")
  stopTab = navigation.bindSelection("inspector", tab, { transient: true })
  move(navigation, 1)
  expect(tab.value).toBe("payload")
  open.value = false
  stopTab()
  stopModal()
  expect(navigation.canForward.value).toBe(false)
})

test("Back dismisses a popup once and Forward never reopens it", () => {
  const navigation = createNavigationSteps()
  navigation.visit("history")
  const popup = shallowRef(false)
  const stop = navigation.bindModal(popup, false, true)
  popup.value = true
  navigation.go(navigation.peek(-1)!.id)
  expect(popup.value).toBe(false)
  expect(navigation.current.value.page).toBe("history")
  expect(navigation.canForward.value).toBe(false)
  navigation.go(navigation.peek(-1)!.id)
  expect(navigation.current.value.page).toBe("overview")
  navigation.go(navigation.peek(1)!.id)
  expect(navigation.current.value.page).toBe("history")
  expect(popup.value).toBe(false)
  stop()
})
