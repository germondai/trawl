import { type InjectionKey, inject, onScopeDispose, provide, shallowRef } from "vue"

type Refresh = () => Promise<unknown>
export function createPageRefresh(prepare: Refresh) {
  const callbacks = new Set<Refresh>()
  const busy = shallowRef(false)
  let pending: Promise<void> | undefined
  return {
    busy,
    register(callback: Refresh) {
      callbacks.add(callback)
      return () => {
        callbacks.delete(callback)
      }
    },
    refresh() {
      if (pending) return pending
      busy.value = true
      pending = (async () => {
        await prepare()
        const results = await Promise.allSettled([...callbacks].map((callback) => callback()))
        const failure = results.find((result) => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
      })().finally(() => {
        busy.value = false
        pending = undefined
      })
      return pending
    },
  }
}
const refreshKey: InjectionKey<ReturnType<typeof createPageRefresh>> = Symbol("page-refresh")
export function providePageRefresh(prepare: Refresh) {
  const refresh = createPageRefresh(prepare)
  provide(refreshKey, refresh)
  return refresh
}
export function usePageRefresh(callback: Refresh) {
  const unregister = inject(refreshKey, undefined)?.register(callback)
  onScopeDispose(() => unregister?.())
}
