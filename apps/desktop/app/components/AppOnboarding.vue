<script setup lang="ts">
import { useNavigationModal } from "~/composables/useNavigationSteps"
import type { Page } from "~/utils/page-history"

const open = defineModel<boolean>("open", { default: false })
const emit = defineEmits<{ navigate: [page: Page, step: string] }>()
const desktop = useDesktopStore()
const completed = useLocalStorage("trawl-tour-v1", false)
useNavigationModal(open, false)
watch(
  () => desktop.loaded,
  async (loaded) => {
    if (!loaded || completed.value) return
    await nextTick()
    if (!document.querySelector('[role="dialog"]') && !desktop.settingsDirty) open.value = true
  },
  { immediate: true },
)
watch(open, (value, previous) => {
  if (previous && !value) completed.value = true
})
</script>
<template>
  <AppTour v-if="open" @close="open = false" @navigate="(page, step) => emit('navigate', page, step)" />
</template>
