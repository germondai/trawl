import { onScopeDispose, shallowRef } from "vue"

/** Resolve a requested refresh after its watcher has read a snapshot, even if that watcher also streams. */
export function useRefreshRevision() {
  const revision = shallowRef(0)
  let disposed = false
  const pending = new Map<number, () => void>()
  const finish = (value: number) => {
    for (const [id, resolve] of pending)
      if (id <= value) {
        pending.delete(id)
        resolve()
      }
  }
  onScopeDispose(() => {
    disposed = true
    finish(Infinity)
  })
  return {
    revision,
    finish,
    refresh: () =>
      new Promise<void>((resolve) => {
        if (disposed) {
          resolve()
          return
        }
        const next = revision.value + 1
        pending.set(next, resolve)
        revision.value = next
      }),
  }
}
