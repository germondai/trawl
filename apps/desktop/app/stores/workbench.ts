import { newWorkbenchDraft, type WorkbenchDraft } from "~/utils/workbench"

export const useWorkbenchStore = defineStore("workbench", () => {
  const desktop = useDesktopStore()
  const draft = ref(newWorkbenchDraft())
  const drafts = new Map<string, WorkbenchDraft>()
  watch(
    () => desktop.activeId,
    (id, previous) => {
      const next = drafts.get(id) ?? newWorkbenchDraft()
      drafts.delete(id)
      if (previous) {
        drafts.delete(previous)
        drafts.set(previous, structuredClone(toRaw(draft.value)))
        while (drafts.size > 3) {
          const oldest = drafts.keys().next().value
          if (oldest === undefined) break
          drafts.delete(oldest)
        }
      }
      draft.value = next
    },
    { flush: "sync" },
  )
  // Drafts remain in memory only; request bodies and target credentials are never persisted automatically.
  return { draft }
})
