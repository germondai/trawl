<script setup lang="ts">
import { type Page, pages } from "~/utils/page-history"

const props = defineProps<{
  page: Page
  canBack: boolean
  canForward: boolean
  nativeMac: boolean
  refreshing: boolean
}>()
const emit = defineEmits<{ back: []; forward: []; restart: []; refresh: [] }>()
const desktop = useDesktopStore()
const current = computed(() => pages.find(({ id }) => id === props.page) ?? pages[0])
const kbds = useShortcutKeys()
const local = computed(() => desktop.activeId === "local")
const overflow = computed(() => [
  {
    label: "Restart server",
    icon: "i-lucide-rotate-cw",
    kbds: kbds("restart"),
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
    :ui="{ left: 'min-w-0 gap-3', center: 'header-center', right: 'shrink-0 gap-1 ms-auto' }"
  >
    <template #left>
      <div class="header-navigation">
        <span v-if="nativeMac" data-native-controls class="native-controls" aria-hidden="true" />
        <UTooltip text="Back"
          ><UButton
            class="header-history"
            icon="i-lucide-chevron-left"
            aria-label="Back"
            color="neutral"
            variant="ghost"
            :disabled="!canBack"
            @click="emit('back')"
          /></UTooltip
        >
        <UTooltip text="Forward"
          ><UButton
            class="header-history"
            icon="i-lucide-chevron-right"
            aria-label="Forward"
            color="neutral"
            variant="ghost"
            :disabled="!canForward"
            @click="emit('forward')"
          /></UTooltip
        >
        <UTooltip text="Toggle sidebar" :kbds="kbds('sidebar')">
          <UDashboardSidebarCollapse :ui="{ base: 'header-sidebar-collapse' }" />
        </UTooltip>
        <UTooltip text="Toggle sidebar" :kbds="kbds('sidebar')"><UDashboardSidebarToggle class="lg:hidden" /></UTooltip>
      </div>
    </template>
    <template #default>
      <span class="header-title"
        ><UIcon :name="current.icon" class="size-4 shrink-0 text-muted" /><span>{{ current.label }}</span></span
      >
    </template>
    <template #right>
      <UTooltip text="Refresh page" :kbds="kbds('refresh')"
        ><UButton
          icon="i-lucide-refresh-cw"
          aria-label="Refresh page"
          :loading="refreshing"
          color="neutral"
          variant="ghost"
          :disabled="!desktop.native || desktop.busy"
          @click="emit('refresh')"
        /></UTooltip
      >
      <UTooltip v-if="local && desktop.status.running" text="Stop server" :kbds="kbds('server')"
        ><UButton
          icon="i-lucide-square"
          aria-label="Stop server"
          color="neutral"
          variant="ghost"
          :loading="desktop.busy"
          :disabled="desktop.busy"
          @click="desktop.stop()"
        /></UTooltip
      >
      <UTooltip
        v-if="local && desktop.browser.installed && !desktop.status.running"
        text="Start server"
        :kbds="kbds('server')"
        ><UButton
          icon="i-lucide-play"
          aria-label="Start server"
          variant="ghost"
          :disabled="!desktop.native || desktop.busy"
          :loading="desktop.busy"
          @click="desktop.start()"
        /></UTooltip
      >
      <UDropdownMenu :items="overflow"
        ><UTooltip text="More actions"
          ><UButton icon="i-lucide-ellipsis" aria-label="More actions" color="neutral" variant="ghost" /></UTooltip
        ></UDropdownMenu
      >
    </template>
  </UDashboardNavbar>
</template>
