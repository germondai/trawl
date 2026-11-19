import {
  computed,
  type InjectionKey,
  inject,
  onMounted,
  onScopeDispose,
  provide,
  type Ref,
  shallowRef,
  watch,
} from "vue"
import type { Page } from "~/utils/page-history"

interface NavigationStep {
  id: number
  page: Page
  selections: Record<string, string>
  modals: number[]
}
type Change = "push" | "replace" | "move"
const same = (a: NavigationStep, b: NavigationStep) =>
  a.page === b.page &&
  a.modals.join() === b.modals.join() &&
  Object.keys(a.selections).length === Object.keys(b.selections).length &&
  Object.entries(a.selections).every(([key, value]) => b.selections[key] === value)

export function createNavigationSteps(page: Page = "overview") {
  let sequence = 0,
    modalSequence = 0,
    applying = false
  const state = shallowRef({
    entries: [{ id: sequence, page, selections: {}, modals: [] } as NavigationStep],
    index: 0,
  })
  const current = computed(() => state.value.entries[state.value.index]!)
  const listeners = new Set<(change: Change) => void>()
  const modals = new Map<
    number,
    {
      open: () => boolean
      restore: () => void
      close: () => void
      clear: () => void
      dismissOnly: boolean
      forget: () => void
    }
  >()
  const modalSelections = new Map<number, Set<string>>()
  function apply(entries: NavigationStep[], index: number, change: Change) {
    const dismissed: (() => void)[] = []
    const previous = applying
    applying = true
    try {
      state.value = { entries, index }
      for (const [id, modal] of modals) {
        if (current.value.modals.includes(id)) modal.restore()
        else if (modal.open()) {
          modal.close()
          if (modal.dismissOnly) dismissed.push(modal.forget)
        }
        if (!modal.open() && !entries.some((entry) => entry.modals.includes(id))) modal.clear()
      }
    } finally {
      applying = previous
    }
    for (const listener of listeners) listener(change)
    for (const forget of dismissed) forget()
  }
  function commit(next: NavigationStep, replace = false, preserveForward = false) {
    if (same(current.value, next)) return
    const entries = state.value.entries.slice()
    if (replace) entries[state.value.index] = { ...next, id: current.value.id }
    else entries.splice(state.value.index + 1, preserveForward ? 0 : entries.length, { ...next, id: ++sequence })
    const index = replace ? state.value.index : state.value.index + 1
    const trim = Math.max(0, Math.min(index - 1, entries.length - 128))
    apply(entries.slice(trim, trim + 128), index - trim, replace ? "replace" : "push")
  }
  function rewrite(map: (entry: NavigationStep) => NavigationStep) {
    const entries: NavigationStep[] = []
    let index = 0
    state.value.entries.forEach((entry, i) => {
      const next = map(entry)
      if (!entries.length || !same(entries[entries.length - 1]!, next)) entries.push(next)
      if (i === state.value.index) index = entries.length - 1
    })
    if (
      index === state.value.index &&
      entries.length === state.value.entries.length &&
      entries.every((entry, i) => entry.id === state.value.entries[i]!.id && same(entry, state.value.entries[i]!))
    )
      return
    apply(entries, index, "replace")
  }
  function selection(key: string, value: string, replace = false) {
    commit({ ...current.value, selections: { ...current.value.selections, [key]: value } }, replace)
  }
  function dropSelection(key: string, value?: string, fallback?: string) {
    rewrite((entry) => {
      if (!(key in entry.selections) || (value !== undefined && entry.selections[key] !== value)) return entry
      const selections = { ...entry.selections }
      if (fallback === undefined) delete selections[key]
      else selections[key] = fallback
      return { ...entry, selections }
    })
  }
  function bindSelection<T extends string>(
    key: string,
    source: Ref<T>,
    options: { transient?: boolean; valid?: (value: T) => boolean } = {},
  ) {
    const owner = options.transient ? current.value.modals.at(-1) : undefined
    if (owner !== undefined) {
      const keys = modalSelections.get(owner) ?? new Set<string>()
      keys.add(key)
      modalSelections.set(owner, keys)
    }
    const restore = (value: string | undefined) => {
      if (value === undefined) return
      if (options.valid && !options.valid(value as T)) dropSelection(key, value, source.value)
      else source.value = value as T
    }
    if (current.value.selections[key] === undefined) selection(key, source.value, true)
    else restore(current.value.selections[key])
    const stopValue = watch(() => current.value.selections[key], restore, { flush: "sync" })
    const stopSource = watch(
      source,
      (value) => {
        if (!applying) selection(key, value)
      },
      { flush: "sync" },
    )
    return () => {
      stopValue()
      stopSource()
      if (
        options.transient &&
        !(owner !== undefined && state.value.entries.some((entry) => entry.modals.includes(owner)))
      )
        dropSelection(key)
    }
  }
  function bindModal<T>(source: Ref<T>, closed: T, dismissOnly = false) {
    const id = ++modalSequence
    let saved = source.value
    let available = source.value !== closed
    const control = {
      dismissOnly,
      forget: () => forget(),
      open: () => source.value !== closed,
      restore: () => {
        if (available && !control.open() && !dismissOnly) source.value = saved
      },
      close: () => {
        source.value = closed
      },
      clear: () => {
        saved = closed
        available = false
      },
    }
    modals.set(id, control)
    const forget = () => {
      const keys = modalSelections.get(id)
      rewrite((entry) => {
        const selections = { ...entry.selections }
        for (const key of keys ?? []) delete selections[key]
        return { ...entry, selections, modals: entry.modals.filter((value) => value !== id) }
      })
      modalSelections.delete(id)
    }
    const stop = watch(
      source,
      (value, previous) => {
        if (value !== closed) {
          saved = value
          available = true
          if (!applying && previous === closed)
            commit({ ...current.value, modals: [...current.value.modals, id] }, false, true)
        } else if (!applying) forget()
      },
      { flush: "sync" },
    )
    if (control.open()) commit({ ...current.value, modals: [...current.value.modals, id] }, false, true)
    return () => {
      stop()
      control.clear()
      modals.delete(id)
      forget()
    }
  }
  function go(id: number) {
    const index = state.value.entries.findIndex((entry) => entry.id === id)
    if (index < 0 || index === state.value.index) return
    apply(state.value.entries, index, "move")
  }
  return {
    current,
    canBack: computed(() => state.value.index > 0),
    canForward: computed(() => state.value.index < state.value.entries.length - 1),
    peek: (direction: -1 | 1) => state.value.entries[state.value.index + direction],
    find: (id: number) => state.value.entries.find((entry) => entry.id === id),
    visit: (next: Page, selections: Record<string, string> = {}) =>
      commit({ ...current.value, page: next, selections: { ...current.value.selections, ...selections }, modals: [] }),
    reset: () => apply([{ ...current.value, modals: [], id: ++sequence }], 0, "replace"),
    go,
    bindSelection,
    bindModal,
    dropSelection,
    subscribe: (listener: (change: Change) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
type Navigation = ReturnType<typeof createNavigationSteps>
const navigationKey: InjectionKey<Navigation> = Symbol("workspace-navigation")
export function provideNavigationSteps() {
  const navigation = createNavigationSteps()
  provide(navigationKey, navigation)
  return navigation
}
export function useNavigationSelection<T extends string>(
  key: string,
  source: Ref<T>,
  options?: { transient?: boolean; valid?: (value: T) => boolean },
) {
  const navigation = inject(navigationKey, undefined)
  const stop = navigation?.bindSelection(key, source, options)
  onScopeDispose(() => stop?.())
  return navigation
}
export function useNavigationModal<T>(source: Ref<T>, closed: T) {
  const navigation = inject(navigationKey, undefined)
  const stop = navigation?.bindModal(source, closed)
  onScopeDispose(() => stop?.())
}

export const confirmationContent = {
  onOpenAutoFocus(event: Event) {
    const root = event.target as HTMLElement
    const target =
      root.querySelector<HTMLButtonElement>("[data-confirm-default]:not(:disabled)") ??
      root.querySelector<HTMLButtonElement>('[data-slot="footer"] button:not(:disabled)')
    if (target) {
      event.preventDefault()
      target.focus({ preventScroll: true })
    }
  },
  onKeydown(event: KeyboardEvent) {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return
    const target = event.target as HTMLElement
    const footer = target.closest('[data-slot="footer"]')
    if (!footer || !target.closest("button")) return
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
    const index = buttons.indexOf(target.closest("button")!)
    event.preventDefault()
    buttons[
      (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length
    ]?.focus()
  },
}

/** Browser Back uses the same guard as native/window navigation; browser state contains opaque IDs only. */
export function useBrowserNavigation(navigation: Navigation, request: (id: number) => void) {
  const marker = useNuxtApp().$navigationSession
  const session = crypto.randomUUID()
  let dispose = () => {}
  onMounted(() => {
    marker.id = session
    let position = 0
    let expected: number | undefined
    let restoring: { position: number; request: () => void } | undefined
    const positions = new Map<number, number>([[0, navigation.current.value.id]])
    const value = (id: number) => ({ ...window.history.state, trawlNavigation: { session, position, id } })
    window.history.replaceState(value(navigation.current.value.id), "")
    const queue: { change: Change; id: number }[] = []
    const drain = () => {
      if (expected !== undefined || restoring) return
      while (queue.length) {
        const action = queue.shift()!
        if (action.change === "move") {
          const candidates = [...positions].filter(([, id]) => id === action.id).map(([offset]) => offset)
          const target = candidates.sort((a, b) => Math.abs(a - position) - Math.abs(b - position))[0]
          if (target !== undefined && target !== position) {
            expected = target
            window.history.go(target - position)
            return
          }
          if (target === undefined) {
            // A confirmation may have replaced the browser's Forward branch while the app kept its destination.
            for (const offset of positions.keys()) if (offset > position) positions.delete(offset)
            position++
            positions.set(position, action.id)
            window.history.pushState(value(action.id), "")
          }
        } else if (action.change === "push") {
          for (const offset of positions.keys()) if (offset > position) positions.delete(offset)
          position++
          positions.set(position, action.id)
          window.history.pushState(value(action.id), "")
        } else {
          positions.set(position, action.id)
          window.history.replaceState(value(action.id), "")
        }
      }
    }
    const unsubscribe = navigation.subscribe((change) => {
      queue.push({ change, id: navigation.current.value.id })
      drain()
    })
    const pop = (event: PopStateEvent) => {
      const next = event.state?.trawlNavigation
      if (next?.session !== session || !Number.isInteger(next.position)) return
      const previous = position
      position = next.position
      if (restoring?.position === position) {
        const action = restoring.request
        restoring = undefined
        action()
        drain()
        return
      }
      if (expected === position) {
        expected = undefined
        drain()
        return
      }
      if (!navigation.find(next.id) || next.id === navigation.current.value.id) {
        if (position !== previous) window.history.go(position < previous ? -1 : 1)
        return
      }
      // Restore the browser cursor before a guard can open a confirmation (and push another step).
      restoring = { position: previous, request: () => request(next.id) }
      window.history.go(previous - position)
    }
    window.addEventListener("popstate", pop)
    dispose = () => {
      unsubscribe()
      window.removeEventListener("popstate", pop)
    }
  })
  onScopeDispose(() => {
    if (marker.id === session) marker.id = ""
    dispose()
  })
}
