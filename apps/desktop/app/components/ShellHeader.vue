<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window"
import { t } from "~/utils/localization"
import { type Page, pages } from "~/utils/page-history"

const props = defineProps<{
  page: Page
  canBack: boolean
  canForward: boolean
  nativeMac: boolean
  refreshing: boolean
  phone: boolean
  sidebarMode: "expanded" | "icons" | "hidden"
}>()
const emit = defineEmits<{ back: []; forward: []; restart: []; refresh: []; sidebar: []; search: [] }>()
const desktop = useDesktopStore()
const windows = desktop.native && /^Win/.test(navigator.platform)
async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  try {
    await getCurrentWindow()[action]()
  } catch (error) {
    desktop.setError(error)
  }
}
const current = computed(() => pages.find(({ id }) => id === props.page) ?? pages[0])
const kbds = useShortcutKeys()
const local = computed(() => desktop.activeId === "local")
const sidebarLabel = computed(() => (props.sidebarMode === "expanded" ? t("ui.toggleSidebar") : t("ui.showSidebar")))
const overflow = computed(() => [
  ...(props.phone
    ? [
        {
          label: desktop.status.running ? t("ui.stopServer") : t("ui.startServer"),
          icon: desktop.status.running ? "i-lucide-square" : "i-lucide-play",
          color: desktop.status.running ? ("error" as const) : ("primary" as const),
          disabled: !local.value || !desktop.native || desktop.busy || !desktop.browser.installed,
          onSelect: () => (desktop.status.running ? desktop.stop() : desktop.start()),
        },
      ]
    : []),
  {
    label: t("ui.restartServer"),
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
    :class="{ 'native-mac': nativeMac, 'native-windows': windows }"
    :data-tauri-drag-region="windows ? true : undefined"
    :ui="{ left: 'min-w-0 gap-3', center: 'header-center', right: 'shrink-0 gap-1 ms-auto' }"
  >
    <template #left>
      <div class="header-navigation" data-tour="page-navigation">
        <span v-if="nativeMac" data-native-controls class="native-controls" aria-hidden="true" />
        <AppTooltip :text="t('ui.back')"
          ><UButton
            class="header-history"
            icon="i-lucide-chevron-left"
            :aria-label="t('ui.back')"
            color="neutral"
            variant="ghost"
            :disabled="!canBack"
            @click="emit('back')"
          /></AppTooltip
        >
        <AppTooltip :text="t('ui.forward')"
          ><UButton
            class="header-history"
            icon="i-lucide-chevron-right"
            :aria-label="t('ui.forward')"
            color="neutral"
            variant="ghost"
            :disabled="!canForward"
            @click="emit('forward')"
          /></AppTooltip
        >
        <AppTooltip v-if="!phone" :text="sidebarLabel" :kbds="kbds('sidebar')">
          <UButton
            :icon="sidebarMode === 'hidden' ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
            :aria-label="sidebarLabel"
            color="neutral"
            variant="ghost"
            @click="emit('sidebar')"
          />
        </AppTooltip>
        <UButton
          v-else
          icon="i-lucide-search"
          data-tour="commands"
          :aria-label="t('ui.searchCommands')"
          color="neutral"
          variant="ghost"
          @click="emit('search')"
        />
      </div>
    </template>
    <template #default>
      <span class="header-title" :data-tauri-drag-region="windows ? true : undefined" data-tour="page-title"
        ><UIcon :name="current.icon" class="size-4 shrink-0 text-muted" /><span>{{ current.label }}</span></span
      >
    </template>
    <template #right
      ><div class="flex items-center gap-1" data-tour="server">
        <AppTooltip v-if="!phone" :text="t('ui.refreshPage')" :kbds="kbds('refresh')"
          ><UButton
            icon="i-lucide-refresh-cw"
            data-tour="refresh"
            :aria-label="t('ui.refreshPage')"
            :loading="refreshing"
            color="neutral"
            variant="ghost"
            :disabled="!desktop.native || desktop.busy"
            @click="emit('refresh')"
          /></AppTooltip
        >
        <AppTooltip v-if="!phone && local && desktop.status.running" :text="t('ui.stopServer')" :kbds="kbds('server')"
          ><UButton
            icon="i-lucide-circle-stop"
            :aria-label="t('ui.stopServer')"
            color="neutral"
            variant="ghost"
            :loading="desktop.busy"
            :disabled="desktop.busy"
            @click="desktop.stop()"
          /></AppTooltip
        >
        <AppTooltip
          v-if="!phone && local && desktop.browser.installed && !desktop.status.running"
          :text="t('ui.startServer')"
          :kbds="kbds('server')"
          ><UButton
            icon="i-lucide-play"
            :aria-label="t('ui.startServer')"
            variant="ghost"
            :disabled="!desktop.native || desktop.busy"
            :loading="desktop.busy"
            @click="desktop.start()"
          /></AppTooltip
        >
        <UDropdownMenu :items="overflow"
          ><AppTooltip :text="t('ui.moreActions')"
            ><UButton
              icon="i-lucide-ellipsis"
              :aria-label="t('ui.moreActions')"
              color="neutral"
              variant="ghost"
              :loading="phone && desktop.busy"
            /></AppTooltip
          ></UDropdownMenu
        >
      </div>
      <div v-if="windows" class="window-controls">
        <UButton
          icon="i-lucide-minus"
          color="neutral"
          variant="ghost"
          :aria-label="t('menu.minimize')"
          @click="windowAction('minimize')"
        />
        <UButton
          icon="i-lucide-square"
          color="neutral"
          variant="ghost"
          :aria-label="t('menu.zoom')"
          @click="windowAction('toggleMaximize')"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          :aria-label="t('native.closeWindow')"
          @click="windowAction('close')"
        />
      </div>
    </template>
  </UDashboardNavbar>
</template>
