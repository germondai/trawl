<script setup lang="ts">
import { type Page, pages } from "~/utils/page-history"

defineProps<{ page: Page }>()
const open = defineModel<boolean>("open", { default: false })
const collapsed = defineModel<boolean>("collapsed", { default: false })
const groups = [
  { label: "Workspace", items: pages.filter((page) => ["overview", "history", "sessions"].includes(page.id)) },
  { label: "Create request", items: pages.filter((page) => page.id === "workbench") },
  { label: "Runtime", items: pages.filter((page) => page.group === "Runtime") },
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
    resizable
    toggle-side="right"
    :default-size="15"
    :min-size="14"
    :max-size="20"
    :collapsed-size="4"
    :ui="{
      root: 'desktop-sidebar min-h-0 min-w-16 overflow-hidden border-0',
      header: 'sidebar-header native-sidebar-header border-0',
      body: 'sidebar-body native-sidebar-body',
      footer: 'sidebar-bottom native-sidebar-footer border-0',
      content: 'mobile-sidebar',
    }"
  >
    <template #header="{ collapsed }">
      <UTooltip text="Overview" :kbds="kbds('overview')"
        ><UButton
          class="brand"
          :class="{ 'brand-collapsed': collapsed }"
          color="neutral"
          variant="ghost"
          aria-label="TRAWL Overview"
          @click="emit('navigate', 'overview')"
        >
          <span class="brand-content"
            ><img src="/logo.png" alt="" width="32" height="32" />
            <span class="sidebar-text brand-wordmark" :class="{ 'opacity-0': collapsed }"
              >trawl<span class="text-primary">.</span></span
            ></span
          >
        </UButton></UTooltip
      >
    </template>
    <template #toggle>
      <UTooltip text="Close menu"
        ><UButton
          class="sidebar-menu-close"
          icon="i-lucide-x"
          aria-label="Close menu"
          color="neutral"
          variant="ghost"
          @click="open = false"
        /></UTooltip
      >
    </template>
    <template #default="{ collapsed }">
      <div class="sidebar-search">
        <UTooltip text="Search commands" :kbds="kbds('search')" :disabled="!collapsed" :content="{ side: 'right' }">
          <UButton
            icon="i-lucide-search"
            label="Search…"
            aria-label="Search commands"
            color="neutral"
            variant="ghost"
            :ui="{ leadingIcon: 'size-5 shrink-0', label: `sidebar-text ${collapsed ? 'opacity-0' : 'opacity-100'}` }"
            @click="emit('search')"
          />
        </UTooltip>
      </div>
      <div class="sidebar-navigation">
        <div v-for="(group, index) in groups" :key="group.label" class="sidebar-group">
          <hr v-if="index > 0" class="sidebar-divider" />
          <nav class="sidebar-nav" :aria-label="group.label">
            <UTooltip
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
            </UTooltip>
          </nav>
        </div>
      </div>
    </template>
    <template #footer="{ collapsed }">
      <UTooltip text="App settings" :kbds="kbds('connections')" :disabled="!collapsed" :content="{ side: 'right' }">
        <UButton
          class="sidebar-settings"
          icon="i-lucide-settings"
          label="App settings"
          aria-label="App settings"
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
      </UTooltip>
      <UTooltip text="Server settings" :kbds="kbds('settings')" :disabled="!collapsed" :content="{ side: 'right' }">
        <UButton
          class="sidebar-settings"
          icon="i-lucide-settings-2"
          label="Server settings"
          aria-label="Server settings"
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
      </UTooltip>
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
          color="neutral"
          variant="ghost"
          :aria-label="`Active instance: ${desktop.active?.name ?? 'Local instance'}, ${connected ? 'connected' : 'not connected'}`"
        >
          <span class="instance-icon" :class="{ connected }"
            ><UIcon name="i-lucide-server" class="size-5" /><span class="dot" :class="{ ready: connected }" /></span
          >
          <span class="sidebar-text instance-label" :class="{ 'opacity-0': collapsed }"
            ><span>{{ desktop.active?.name ?? "Local instance" }}</span
            ><small>{{ connected ? "Connected" : "Not connected" }}</small></span
          >
          <UIcon
            name="i-lucide-chevrons-up-down"
            class="sidebar-text size-4 shrink-0 ms-auto"
            :class="{ 'opacity-0': collapsed }"
          />
        </UButton>
        <template #content
          ><div class="instance-popover">
            <strong>Active instance</strong>
            <USelect
              :model-value="desktop.activeId"
              :items="connections"
              aria-label="Active instance"
              @update:model-value="emit('select', String($event))"
            />
            <div class="instance-address">
              <input
                ref="addressField"
                class="mono"
                :value="address"
                readonly
                aria-label="Instance address"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <UTooltip :text="copyState === 'copied' ? 'Copied' : 'Copy address'"
                ><UButton
                  :icon="copyState === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'"
                  :aria-label="copyState === 'copied' ? 'Instance address copied' : 'Copy instance address'"
                  color="neutral"
                  variant="ghost"
                  :disabled="!address || copyState === 'copying'"
                  @click="copyAddress"
                /></UTooltip
              >
            </div>
            <p v-if="copyState === 'copied' || copyState === 'failed'" role="status">
              {{ copyState === "copied" ? "Address copied" : "Select the address and copy it manually." }}
            </p>
            <UButton
              label="Manage connections"
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
