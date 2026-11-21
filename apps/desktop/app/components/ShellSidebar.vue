<script setup lang="ts">
import { t } from "~/utils/localization"
import { type Page, pages } from "~/utils/page-history"

defineProps<{ page: Page; hidden?: boolean }>()
const open = defineModel<boolean>("open", { default: false })
const collapsed = defineModel<boolean>("collapsed", { default: false })
const groups = [
  {
    get label() {
      return t("ui.workspace")
    },
    items: pages.filter((page) => ["overview", "history", "sessions"].includes(page.id)),
  },
  {
    get label() {
      return t("ui.createRequest")
    },
    items: pages.filter((page) => page.id === "workbench"),
  },
  {
    get label() {
      return t("ui.runtime")
    },
    items: pages.filter((page) => page.group === "Runtime"),
  },
]
const emit = defineEmits<{
  navigate: [page: Page]
  select: [id: string]
  search: []
}>()
const desktop = useDesktopStore()
const kbds = useShortcutKeys()
const mainPane = shallowRef<HTMLElement>()
onMounted(() => {
  mainPane.value = document.querySelector<HTMLElement>("[data-native-workspace] .workspace") ?? undefined
})
const address = computed(() => desktop.active?.baseURL ?? "")
const addressField = useTemplateRef<HTMLInputElement>("addressField")
const copyState = shallowRef<"idle" | "copying" | "copied" | "failed">("idle")
const { start: resetCopied, stop: stopCopied } = useTimeoutFn(
  () => {
    copyState.value = "idle"
  },
  2000,
  { immediate: false },
)
let copyGeneration = 0
watch(address, () => {
  copyGeneration++
  stopCopied()
  copyState.value = "idle"
})
async function copyAddress(event: MouseEvent) {
  const value = address.value
  const generation = ++copyGeneration
  const trigger = event.currentTarget as HTMLButtonElement
  stopCopied()
  copyState.value = "copying"
  let success = false
  try {
    await navigator.clipboard.writeText(value)
    success = true
  } catch {
    /* Older WebViews use the selected field below. */
  }
  if (generation !== copyGeneration || value !== address.value) return
  if (!success && addressField.value) {
    try {
      addressField.value.select()
      success = document.execCommand("copy")
    } catch {
      success = false
    } finally {
      trigger.focus({ preventScroll: true })
    }
  }
  if (generation !== copyGeneration || value !== address.value) return
  copyState.value = success ? "copied" : "failed"
  if (success) resetCopied()
}
const connected = computed(() => desktop.health?.status === "ok")
const connections = computed(() => desktop.instances.map(({ id, name }) => ({ label: name, value: id })))
</script>
<template>
  <UDashboardSidebar
    v-model:open="open"
    v-model:collapsed="collapsed"
    id="main"
    collapsible
    :resizable="!hidden"
    toggle-side="right"
    :default-size="15"
    :min-size="14"
    :max-size="20"
    :collapsed-size="4"
    :ui="{
      root: `desktop-sidebar min-h-0 min-w-16 overflow-hidden border-0 ${hidden ? 'sidebar-hidden' : ''}`,
      header: 'sidebar-header native-sidebar-header border-0',
      body: 'sidebar-body native-sidebar-body',
      footer: 'sidebar-bottom native-sidebar-footer border-0',
      content: 'mobile-sidebar',
    }"
  >
    <template #header="{ collapsed }">
      <AppTooltip :text="t('ui.overview')" :kbds="kbds('overview')"
        ><UButton
          class="brand"
          :class="{ 'brand-collapsed': collapsed }"
          color="neutral"
          variant="ghost"
          :aria-label="t('ui.trawlOverview')"
          @click="emit('navigate', 'overview')"
        >
          <span class="brand-content"
            ><img src="/logo.png" alt="" width="32" height="32" />
            <span class="sidebar-text brand-wordmark" :class="{ 'opacity-0': collapsed }"
              >trawl<span class="text-primary">.</span></span
            ></span
          >
        </UButton></AppTooltip
      >
    </template>
    <template #toggle>
      <AppTooltip :text="t('ui.closeMenu')"
        ><UButton
          class="sidebar-menu-close"
          icon="i-lucide-x"
          :aria-label="t('ui.closeMenu')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        /></AppTooltip
      >
    </template>
    <template #default="{ collapsed }">
      <div class="sidebar-search">
        <AppTooltip
          :text="t('ui.searchCommands')"
          :kbds="kbds('search')"
          :disabled="!collapsed"
          :content="{ side: 'right' }"
        >
          <UButton
            icon="i-lucide-search"
            data-tour="commands"
            :label="t('ui.search')"
            :aria-label="t('ui.searchCommands')"
            color="neutral"
            variant="ghost"
            :ui="{ leadingIcon: 'size-5 shrink-0', label: `sidebar-text ${collapsed ? 'opacity-0' : 'opacity-100'}` }"
            @click="emit('search')"
          />
        </AppTooltip>
      </div>
      <div class="sidebar-navigation" data-tour="navigation">
        <div v-for="(group, index) in groups" :key="group.label" class="sidebar-group">
          <hr v-if="index > 0" class="sidebar-divider" />
          <nav class="sidebar-nav" :aria-label="group.label">
            <AppTooltip
              v-for="item in group.items"
              :key="item.id"
              :text="item.label"
              :kbds="kbds(item.id)"
              :disabled="!collapsed"
              :content="{ side: 'right' }"
            >
              <UButton
                :icon="item.icon"
                :label="item.label"
                :aria-label="item.label"
                :aria-current="page === item.id ? 'page' : undefined"
                :class="{ selected: page === item.id }"
                :ui="{
                  leadingIcon: 'size-5 shrink-0',
                  label: `sidebar-text truncate ${collapsed ? 'opacity-0' : 'opacity-100'}`,
                }"
                color="neutral"
                variant="ghost"
                @click="emit('navigate', item.id)"
              />
            </AppTooltip>
          </nav>
        </div>
      </div>
    </template>
    <template #footer="{ collapsed }">
      <AppTooltip
        :text="t('ui.appSettings')"
        :kbds="kbds('connections')"
        :disabled="!collapsed"
        :content="{ side: 'right' }"
      >
        <UButton
          class="sidebar-settings"
          icon="i-lucide-settings"
          :label="t('ui.appSettings')"
          :aria-label="t('ui.appSettings')"
          :aria-current="page === 'connections' ? 'page' : undefined"
          :class="{ selected: page === 'connections' }"
          color="neutral"
          variant="ghost"
          :ui="{
            leadingIcon: 'size-5 shrink-0',
            label: `sidebar-text truncate ${collapsed ? 'opacity-0' : 'opacity-100'}`,
          }"
          @click="emit('navigate', 'connections')"
        />
      </AppTooltip>
      <AppTooltip
        :text="t('ui.serverSettings')"
        :kbds="kbds('settings')"
        :disabled="!collapsed"
        :content="{ side: 'right' }"
      >
        <UButton
          class="sidebar-settings"
          icon="i-lucide-settings-2"
          :label="t('ui.serverSettings')"
          :aria-label="t('ui.serverSettings')"
          :aria-current="page === 'settings' ? 'page' : undefined"
          :class="{ selected: page === 'settings' }"
          color="neutral"
          variant="ghost"
          :ui="{
            leadingIcon: 'size-5 shrink-0',
            label: `sidebar-text truncate ${collapsed ? 'opacity-0' : 'opacity-100'}`,
          }"
          @click="emit('navigate', 'settings')"
        />
      </AppTooltip>
      <hr class="sidebar-divider" />
      <UPopover
        :content="{
          side: 'right',
          align: 'end',
          sideOffset: 8,
          collisionBoundary: mainPane,
          collisionPadding: 12,
          prioritizePosition: true,
          sticky: 'always',
        }"
      >
        <UButton
          class="instance-trigger"
          data-tour="instance"
          color="neutral"
          variant="ghost"
          :aria-label="
            t('ui.activeInstance', {
              p0: desktop.active?.name ?? t('ui.localInstance'),
              p1: connected ? t('ui.connected') : t('ui.notConnected'),
            })
          "
        >
          <span class="instance-icon" :class="{ connected }"
            ><UIcon name="i-lucide-server" class="size-5" /><span class="dot" :class="{ ready: connected }" /></span
          >
          <span class="sidebar-text instance-label" :class="{ 'opacity-0': collapsed }"
            ><span>{{ desktop.active?.name ?? t("ui.localInstance") }}</span
            ><small>{{ connected ? t("ui.connected") : t("ui.notConnected") }}</small></span
          >
          <UIcon
            name="i-lucide-chevrons-up-down"
            class="sidebar-text size-4 shrink-0 ms-auto"
            :class="{ 'opacity-0': collapsed }"
          />
        </UButton>
        <template #content
          ><div class="instance-popover">
            <strong>{{ t("ui.activeInstance2") }}</strong>
            <USelect
              :model-value="desktop.activeId"
              :items="connections"
              :aria-label="t('ui.activeInstance2')"
              @update:model-value="emit('select', String($event))"
            />
            <div class="instance-address">
              <input
                ref="addressField"
                class="mono"
                :value="address"
                readonly
                :aria-label="t('ui.instanceAddress')"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <AppTooltip :text="copyState === 'copied' ? t('ui.copied') : t('ui.copyAddress')"
                ><UButton
                  :icon="copyState === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :aria-label="copyState === 'copied' ? t('ui.instanceAddressCopied') : t('ui.copyInstanceAddress')"
                  color="neutral"
                  variant="ghost"
                  :disabled="!address || copyState === 'copying'"
                  @click="copyAddress"
                /></AppTooltip
              >
            </div>
            <p v-if="copyState === 'copied' || copyState === 'failed'" role="status">
              {{ copyState === "copied" ? t("ui.addressCopied") : t("ui.selectTheAddressAndCopyItManually") }}
            </p>
            <UButton
              :label="t('ui.manageConnections')"
              icon="i-lucide-network"
              color="neutral"
              variant="ghost"
              @click="emit('navigate', 'connections')"
            />
          </div></template
        >
      </UPopover>
    </template>
  </UDashboardSidebar>
</template>
