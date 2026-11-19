import type { Setting } from "@trawl/config/catalog"
import type { Ref } from "vue"
import { scrollWorkspaceToTop } from "~/composables/useWorkspaceScroll"
import type { SettingTarget } from "~/utils/setting-navigation"
import { sectionFor, type settingSections } from "~/utils/settings"

export function useSettingFocus(
  target: () => SettingTarget | undefined,
  settings: () => readonly Pick<Setting, "name" | "group">[],
  query: Ref<string>,
  selected: Ref<(typeof settingSections)[number]["id"]>,
  consumed: () => void,
) {
  const scrollToTop = inject(scrollWorkspaceToTop)
  watch(selected, async () => {
    if (target()) return
    await nextTick()
    scrollToTop?.()
  })
  const highlighted = shallowRef("")
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopTimer = () => clearTimeout(timer)
  onBeforeUnmount(stopTimer)
  let consumedRevision: number | undefined
  const clearHighlight = () => {
    highlighted.value = ""
  }
  watch(query, clearHighlight)
  watch(
    [() => target()?.revision, () => settings().length],
    async (_, __, onCleanup) => {
      const wanted = target()
      const setting = settings().find(({ name }) => name === wanted?.name)
      if (!wanted || !setting || wanted.revision === consumedRevision) return
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })
      query.value = wanted.name
      selected.value = sectionFor(setting) as (typeof settingSections)[number]["id"]
      await nextTick()
      if (cancelled) return
      consumedRevision = wanted.revision
      highlighted.value = wanted.name
      stopTimer()
      timer = setTimeout(clearHighlight, 2500)
      consumed()
      const row = document.getElementById(`setting-${wanted.name}`)
      row?.scrollIntoView({ block: "center" })
      row
        ?.querySelector<HTMLElement>(
          '.setting-control input,.setting-control button,.setting-control textarea,.setting-control [role="combobox"]',
        )
        ?.focus({ preventScroll: true })
    },
    { immediate: true },
  )
  return { highlighted }
}
