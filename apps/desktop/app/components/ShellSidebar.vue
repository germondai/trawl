<script setup lang="ts">
import { type Page, pages } from "~/utils/page-history"

defineProps<{ page: Page }>()
const open = defineModel<boolean>("open", { default: false })
const emit = defineEmits<{ navigate: [page: Page]; select: [id: string] }>()
const desktop = useDesktopStore()
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
const connections = computed(() => [
  { label: "Local instance", value: "local" },
  ...desktop.config.desktop.connections.map(({ id, name }) => ({ label: name, value: id })),
])
</script>
<template>
  <UDashboardSidebar
    v-model:open="open"
    id="main"
    collapsible
    resizable
    :default-size="15"
    :min-size="14"
    :max-size="20"
    :collapsed-size="4"
    :ui="{
      root: 'desktop-sidebar min-h-0 min-w-16 overflow-hidden border-0',
      header: 'sidebar-header native-sidebar-header',
      body: 'sidebar-body native-sidebar-body',
      footer: 'sidebar-bottom native-sidebar-footer',
    }"
  >
    <template #header="{ collapsed }">
      <UButton
        class="brand"
        color="neutral"
        variant="ghost"
        aria-label="TRAWL Overview"
        title="Overview"
        @click="emit('navigate', 'overview')"
      >
        <img src="/logo.png" alt="" width="32" height="32" />
        <span class="sidebar-text brand-wordmark" :class="{ 'opacity-0': collapsed }"
          >trawl<span class="text-primary">.</span></span
        >
      </UButton>
      <hr class="sidebar-header-divider" />
    </template>
    <template #default="{ collapsed }">
      <div v-for="(group, index) in [pages.slice(0, 4), pages.slice(4)]" :key="index" class="sidebar-group">
        <hr v-if="index > 0" class="sidebar-divider" />
        <nav class="sidebar-nav" :aria-label="index ? 'Management' : 'Workspace'">
          <UTooltip
            v-for="item in group"
            :key="item.id"
            :text="item.label"
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
    </template>
    <template #footer="{ collapsed }">
      <hr class="sidebar-divider" />
      <UPopover :content="{ side: 'right', align: 'end' }">
        <UButton
          class="instance-trigger"
          color="neutral"
          variant="ghost"
          :aria-label="`Active instance: ${desktop.active?.name ?? 'Local instance'}, ${connected ? 'connected' : 'not connected'}`"
          title="Select instance"
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
              <UButton
                :icon="copyState === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'"
                :aria-label="copyState === 'copied' ? 'Instance address copied' : 'Copy instance address'"
                :title="copyState === 'copied' ? 'Copied' : 'Copy address'"
                color="neutral"
                variant="ghost"
                :disabled="!address || copyState === 'copying'"
                @click="copyAddress"
              />
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
