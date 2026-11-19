import { computed, ref, watch } from "vue"
import { newWorkbenchDraft, type WorkbenchDraft } from "~/utils/workbench"

const newTab = () => ({ id: crypto.randomUUID(), draft: newWorkbenchDraft() })
type RequestTabs = { tabs: ReturnType<typeof newTab>[]; activeId: string }

export const useWorkbenchStore = defineStore("workbench", () => {
  const desktop = useDesktopStore()
  const first = newTab()
  const tabs = ref([first])
  const activeTabId = ref<string>(first.id)
  function activeTab() {
    const tab = tabs.value.find(({ id }) => id === activeTabId.value) ?? tabs.value[0]
    if (!tab) throw new Error("No active request tab")
    return tab
  }
  const draft = computed({
    get: () => activeTab().draft,
    set: (value: WorkbenchDraft) => {
      activeTab().draft = value
    },
  })
  const drafts = new Map<string, RequestTabs>()
  function addTab() {
    if (tabs.value.length >= 8) return false
    const tab = newTab()
    tabs.value.push(tab)
    activeTabId.value = tab.id
    return true
  }
  function closeTab(id: string) {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    if (index < 0) return
    if (tabs.value.length === 1) {
      draft.value = newWorkbenchDraft()
      return
    }
    tabs.value.splice(index, 1)
    const next = tabs.value[Math.min(index, tabs.value.length - 1)]
    if (activeTabId.value === id && next) activeTabId.value = next.id
  }
  watch(
    () => desktop.activeId,
    (id, previous) => {
      const initial = newTab()
      const next = drafts.get(id) ?? { tabs: [initial], activeId: initial.id }
      drafts.delete(id)
      if (previous) {
        drafts.delete(previous)
        drafts.set(previous, JSON.parse(JSON.stringify({ tabs: tabs.value, activeId: activeTabId.value })))
        while (drafts.size > 3) {
          const oldest = drafts.keys().next().value
          if (oldest === undefined) break
          drafts.delete(oldest)
        }
      }
      tabs.value = next.tabs
      activeTabId.value = next.activeId
    },
    { flush: "sync" },
  )
  // Drafts remain in memory only; request bodies and target credentials are never persisted automatically.
  return { draft, tabs, activeTabId, addTab, closeTab }
})
