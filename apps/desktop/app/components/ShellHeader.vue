<script setup lang="ts">
import { type Page, pages } from "~/utils/page-history"

const props = defineProps<{
  page: Page
  canBack: boolean
  canForward: boolean
  nativeMac: boolean
  scrolled: boolean
}>()
const emit = defineEmits<{ back: []; forward: []; restart: [] }>()
const desktop = useDesktopStore()
const current = computed(() => pages.find(({ id }) => id === props.page) ?? pages[0])
const local = computed(() => desktop.activeId === "local")
const overflow = computed(() => [
  {
    label: "Restart server",
    icon: "i-lucide-rotate-cw",
    disabled: !local.value || !desktop.status.running || desktop.busy,
    onSelect: () => emit("restart"),
  },
])
</script>
<template>
  <UDashboardNavbar
    as="header"
    :toggle="false"
    class="workspace-navbar"
    :class="{ 'is-scrolled': scrolled }"
    :ui="{ left: 'min-w-0 flex-1 gap-3', right: 'shrink-0 gap-1' }"
  >
    <template #left>
      <div class="header-navigation">
        <span v-if="nativeMac" data-native-controls class="native-controls" aria-hidden="true" />
        <UTooltip text="Back"
          ><UButton
            icon="i-lucide-chevron-left"
            aria-label="Back"
            title="Back"
            color="neutral"
            variant="ghost"
            :disabled="!canBack"
            @click="emit('back')"
          /></UTooltip
        >
        <UTooltip text="Forward"
          ><UButton
            icon="i-lucide-chevron-right"
            aria-label="Forward"
            title="Forward"
            color="neutral"
            variant="ghost"
            :disabled="!canForward"
            @click="emit('forward')"
          /></UTooltip
        >
        <UDashboardSidebarCollapse title="Toggle sidebar" :ui="{ base: 'header-sidebar-collapse' }" />
        <UDashboardSidebarToggle title="Open sidebar" class="lg:hidden" />
      </div>
      <span class="header-title"
        ><UIcon :name="current.icon" class="size-4 shrink-0 text-muted" /><span>{{ current.label }}</span></span
      >
    </template>
    <template #right>
      <UTooltip text="Refresh instance"
        ><UButton
          icon="i-lucide-refresh-cw"
          aria-label="Refresh instance"
          title="Refresh instance"
          color="neutral"
          variant="ghost"
          :disabled="!desktop.native || desktop.busy"
          @click="desktop.refresh()"
        /></UTooltip
      >
      <UTooltip v-if="local && desktop.status.running" text="Stop server"
        ><UButton
          icon="i-lucide-square"
          aria-label="Stop server"
          title="Stop server"
          color="neutral"
          variant="ghost"
          :loading="desktop.busy"
          :disabled="desktop.busy"
          @click="desktop.stop()"
        /></UTooltip
      >
      <UTooltip v-if="local && desktop.browser.installed && !desktop.status.running" text="Start server"
        ><UButton
          icon="i-lucide-play"
          aria-label="Start server"
          title="Start server"
          variant="ghost"
          :disabled="!desktop.native || desktop.busy"
          :loading="desktop.busy"
          @click="desktop.start()"
        /></UTooltip
      >
      <UDropdownMenu :items="overflow"
        ><UButton
          icon="i-lucide-ellipsis"
          aria-label="More actions"
          title="More actions"
          color="neutral"
          variant="ghost"
        /></UDropdownMenu
      >
    </template>
  </UDashboardNavbar>
</template>
