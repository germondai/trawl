<script setup lang="ts">
import type { CommandPaletteGroup } from "@nuxt/ui"
import { type ShortcutAction } from "@trawl/config/catalog"
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { t } from "~/utils/localization"
import { type Page, pages } from "~/utils/page-history"
import { settingDescription, settingLabel } from "~/utils/settings"

const open = defineModel<boolean>("open", { default: false })
useNavigationModal(open, false)
const props = defineProps<{ page: Page }>()
const emit = defineEmits<{
  action: [action: ShortcutAction]
  navigate: [page: Page]
  onboarding: []
  setting: [name: string]
  select: [id: string]
}>()
const desktop = useDesktopStore()
// Polling replaces status objects even when the visible command state stays the same.
const running = computed(() => desktop.status.running)
const browserInstalled = computed(() => desktop.browser.installed)
const mac = /Mac/.test(navigator.platform)
const search = shallowRef("")
watch(open, () => {
  search.value = ""
})
function choose(action: () => void) {
  open.value = false
  action()
}
const kbds = useShortcutKeys()
const groups = computed<CommandPaletteGroup[]>(() => [
  {
    id: "pages",
    label: t("ui.pages"),
    items: pages
      .filter((page) => page.id !== "workbench")
      .map((page) => ({
        id: page.id,
        label: page.label,
        icon: page.icon,
        active: props.page === page.id,
        kbds: kbds(page.id),
        onSelect: () => choose(() => emit("navigate", page.id)),
      })),
  },
  {
    id: "actions",
    label: t("ui.actions"),
    items: [
      {
        id: "onboarding",
        label: t("onboarding.open"),
        icon: "i-lucide-info",
        onSelect: () => choose(() => emit("onboarding")),
      },
      {
        id: "new-request",
        label: t("ui.newRequest"),
        icon: "i-lucide-plus",
        kbds: kbds("workbench"),
        onSelect: () => choose(() => emit("action", "workbench")),
      },
      {
        id: "refresh",
        label: t("ui.refreshPage"),
        icon: "i-lucide-refresh-cw",
        kbds: kbds("refresh"),
        disabled: !desktop.native || desktop.busy,
        onSelect: () => choose(() => emit("action", "refresh")),
      },
      {
        id: "sidebar",
        label: t("ui.toggleSidebar"),
        icon: "i-lucide-panel-left-close",
        kbds: kbds("sidebar"),
        onSelect: () => choose(() => emit("action", "sidebar")),
      },
      {
        id: "server",
        label: running.value ? t("ui.stopLocalServer") : t("ui.startLocalServer"),
        icon: running.value ? "i-lucide-square" : "i-lucide-play",
        kbds: kbds("server"),
        disabled:
          !desktop.native ||
          desktop.activeId !== "local" ||
          desktop.busy ||
          (!running.value && !browserInstalled.value),
        onSelect: () => choose(() => emit("action", "server")),
      },
      {
        id: "restart",
        label: t("ui.restartLocalServer"),
        icon: "i-lucide-rotate-cw",
        kbds: kbds("restart"),
        disabled: !desktop.native || desktop.activeId !== "local" || !running.value || desktop.busy,
        onSelect: () => choose(() => emit("action", "restart")),
      },
    ],
  },
  {
    id: "instances",
    label: t("ui.instances"),
    items: desktop.instances.map((connection) => ({
      id: connection.id,
      label: connection.name,
      icon: "i-lucide-server",
      active: desktop.activeId === connection.id,
      onSelect: () => choose(() => emit("select", connection.id)),
    })),
  },
  {
    id: "settings",
    label: t("ui.serverSettings"),
    items: search.value.trim()
      ? desktop.catalog.map((setting) => ({
          id: setting.name,
          label: settingLabel(setting),
          suffix: setting.name,
          description: settingDescription(setting),
          icon: "i-lucide-settings-2",
          onSelect: () => choose(() => emit("setting", setting.name)),
        }))
      : [],
  },
])
function jumpGroup(event: KeyboardEvent) {
  if (
    !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) ||
    event.altKey ||
    event.shiftKey ||
    event.isComposing ||
    !["ArrowUp", "ArrowDown"].includes(event.key)
  )
    return
  const root = event.currentTarget as HTMLElement
  const groups = [...root.querySelectorAll<HTMLElement>('[role="group"]')].filter((group) =>
    group.querySelector('[role="option"]:not([data-disabled])'),
  )
  const current = root.querySelector("[data-highlighted]")?.closest('[role="group"]')
  const index = groups.findIndex((group) => group === current)
  const next =
    index < 0
      ? event.key === "ArrowDown"
        ? 0
        : groups.length - 1
      : Math.max(0, Math.min(groups.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
  event.preventDefault()
  event.stopPropagation()
  if (next === index) return
  const item = groups[next]?.querySelector<HTMLElement>('[role="option"]:not([data-disabled])')
  // Use the palette's hover highlighting so keyboard focus stays in the search field.
  item?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }))
  item?.scrollIntoView({ block: "nearest" })
}
</script>
<template>
  <AppDialog
    v-model:open="open"
    :title="t('ui.searchCommands')"
    :description="t('ui.findAPageActionInstanceOrServerSetting')"
    :ui="{ content: 'command-dialog overflow-hidden' }"
  >
    <template #content>
      <UCommandPalette
        v-model:search-term="search"
        :groups="groups"
        :placeholder="t('ui.searchPagesSettingsAndCommands')"
        close
        @keydown.capture="jumpGroup"
        @update:open="open = $event"
      />
    </template>
  </AppDialog>
</template>
<style>
.command-dialog {
  max-height: min(560px, calc(100dvh - 32px));
}
</style>
