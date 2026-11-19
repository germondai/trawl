<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core"
import { type Connection, orderedInstanceIds, type UserConfig } from "@trawl/config/catalog"
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"

const desktop = useDesktopStore()
const instanceURLPlaceholder = "https://trawl.example.com"
const macOS = /Mac/.test(navigator.platform)
const name = shallowRef("")
const baseURL = shallowRef("")
const apiKey = shallowRef("")
const editing = shallowRef<Connection>()
const editDirty = shallowRef(false)
const removing = shallowRef<Connection>()
const shortcutDirty = shallowRef(false)
const dirty = computed(() => Boolean(name.value || baseURL.value || apiKey.value))
watch(
  [dirty, shortcutDirty, editDirty],
  ([connection, shortcuts, modal]) => {
    desktop.settingsDirty = connection || shortcuts || modal
  },
  { flush: "sync" },
)
onBeforeUnmount(() => {
  desktop.settingsDirty = false
})
useNavigationModal(removing, undefined)
useNavigationModal(editing, undefined)
const canSave = computed(
  () => desktop.native && !desktop.busy && Boolean(name.value.trim()) && Boolean(baseURL.value.trim()),
)
async function openAddress(event: MouseEvent, url: string) {
  if (!desktop.native) return
  event.preventDefault()
  try {
    await invoke("open_connection_url", { url })
  } catch (cause) {
    desktop.error = String(cause)
  }
}
function cancel() {
  name.value = ""
  baseURL.value = ""
  apiKey.value = ""
}
async function saveConnection() {
  if (!canSave.value) return
  const config = structuredClone(toRaw(desktop.config))
  const connection = {
    id: crypto.randomUUID(),
    name: name.value.trim(),
    baseURL: baseURL.value.trim(),
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
  }
  config.desktop.instanceOrder = [...orderedInstanceIds(config.desktop), connection.id]
  config.desktop.connections.push(connection)
  if (await desktop.save(config)) cancel()
}
async function reorder(id: string, direction: -1 | 1) {
  if (!(await desktop.reorderInstance(id, direction)))
    useToast().add({ title: "Could not change connection order", description: desktop.error, color: "error" })
}
async function remove() {
  const id = removing.value?.id
  if (!id || id === "local") return
  const config = structuredClone(toRaw(desktop.config))
  config.desktop.instanceOrder = orderedInstanceIds(config.desktop).filter((value) => value !== id)
  config.desktop.connections = config.desktop.connections.filter((connection) => connection.id !== id)
  if (!(await desktop.save(config))) return
  removing.value = undefined
  if (desktop.activeId === id) await desktop.select("local")
}
async function preference(
  key: "closeBehavior" | "quitBehavior" | "appVisibility" | "autostart" | "startServerOnLaunch" | "smoothScroll",
  value: unknown,
) {
  const config = structuredClone(toRaw(desktop.config))
  if (key === "closeBehavior") config.desktop.closeBehavior = value as UserConfig["desktop"]["closeBehavior"]
  else if (key === "quitBehavior") config.desktop.quitBehavior = value as UserConfig["desktop"]["quitBehavior"]
  else if (key === "appVisibility") config.desktop.appVisibility = value as UserConfig["desktop"]["appVisibility"]
  else config.desktop[key] = Boolean(value)
  await desktop.save(config)
}
</script>
<template>
  <div class="panel">
    <div class="panel-heading"><h2>Application behavior</h2></div>
    <div class="panel-body form-stack">
      <UFormField
        v-if="!desktop.mobile"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        label="When the window closes"
        description="Close the window and keep TRAWL available, or quit and stop the server started by this application."
        ><USelect
          :model-value="desktop.config.desktop.closeBehavior"
          :items="[
            { label: 'Ask me', value: 'ask' },
            { label: 'Keep running in background', value: 'tray' },
            { label: 'Quit and stop my server', value: 'quit' },
          ]"
          :disabled="!desktop.native || desktop.busy"
          class="preference-select"
          @update:model-value="preference('closeBehavior', $event)"
        /></UFormField
      >
      <UFormField
        v-if="!desktop.mobile && macOS"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        label="Quit shortcut behavior"
        description="Quit TRAWL and stop its local server. Menu actions always quit directly; unsaved settings still ask for confirmation."
      >
        <USelect
          :model-value="desktop.config.desktop.quitBehavior"
          :items="[
            { label: 'Quit immediately', value: 'immediate' },
            { label: 'Press twice', value: 'double-press' },
            { label: 'Hold for one second', value: 'hold' },
          ]"
          class="preference-select"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('quitBehavior', $event)"
        />
      </UFormField>
      <UFormField
        v-if="!desktop.mobile && macOS"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        label="Show TRAWL in"
        description="Choose where TRAWL stays accessible after closing its window. An open window also appears in the Dock and Command-Tab."
      >
        <USelect
          :model-value="desktop.config.desktop.appVisibility"
          :items="[
            { label: 'Dock and menu bar', value: 'dock-and-tray' },
            { label: 'Dock', value: 'dock' },
            { label: 'Menu bar', value: 'tray' },
          ]"
          class="preference-select"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('appVisibility', $event)"
        />
      </UFormField>
      <UFormField
        v-if="!desktop.mobile"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        label="Start TRAWL when I sign in"
        ><USwitch
          :model-value="desktop.config.desktop.autostart"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('autostart', $event)"
        /><template #description
          >Starts the desktop application in the background. You can disable this at any time.</template
        ></UFormField
      ><UFormField
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        label="Start the local server with the application"
      >
        <USwitch
          :model-value="desktop.config.desktop.startServerOnLaunch"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('startServerOnLaunch', $event)"
        />
        <template #description
          >Requires the browser to be installed. The server keeps your configured resource profile.</template
        >
      </UFormField>
      <UFormField
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        label="Smooth wheel scrolling"
        description="Use Lenis for smooth wheel scrolling throughout the app, including dialogs, lists and editors. Touch scrolling and reduced-motion preferences stay native."
        ><USwitch
          :model-value="desktop.config.desktop.smoothScroll"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('smoothScroll', $event)"
        /></UFormField
      >
    </div>
  </div>
  <KeyboardSettings v-if="!desktop.mobile" @dirty="shortcutDirty = $event" />
  <div class="panel">
    <div class="panel-heading"><h2>Saved connections</h2></div>
    <div v-for="(connection, index) in desktop.instances" :key="connection.id" class="connection">
      <div>
        <div class="flex items-center gap-2">
          <strong>{{ connection.name }}</strong>
          <UTooltip v-if="connection.id === 'local'" text="Managed on this device"
            ><UIcon
              name="i-lucide-monitor"
              class="size-4 text-primary"
              role="img"
              aria-label="Local instance"
            /></UTooltip
          >
        </div>
        <p class="mono text-xs">
          <a
            :href="connection.baseURL"
            @click="openAddress($event, connection.baseURL)"
            target="_blank"
            rel="noopener noreferrer"
            class="connection-address"
            >{{
              connection.baseURL
            }}</a
          >
        </p>
      </div>
      <div class="actions">
        <UButton
          color="neutral"
          variant="outline"
          :disabled="!desktop.native || desktop.busy || desktop.settingsDirty || desktop.activeId === connection.id"
          @click="desktop.select(connection.id)"
          >{{
            desktop.activeId === connection.id ? "Selected" : "Connect"
          }}</UButton
        >
        <UTooltip text="Move up"
          ><span
            ><UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-chevron-up"
              :aria-label="`Move ${connection.name} up`"
              :disabled="index === 0 || !desktop.native || desktop.busy || desktop.settingsDirty"
              @click="reorder(connection.id, -1)"
            /></span
          ></UTooltip
        >
        <UTooltip text="Move down"
          ><span
            ><UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-chevron-down"
              :aria-label="`Move ${connection.name} down`"
              :disabled="
                index === desktop.instances.length - 1 || !desktop.native || desktop.busy || desktop.settingsDirty
              "
              @click="reorder(connection.id, 1)"
            /></span
          ></UTooltip
        >
        <UTooltip text="Edit connection">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-pencil"
            :aria-label="`Edit ${connection.name}`"
            :disabled="!desktop.native || desktop.busy || dirty"
            @click="editing = connection"
          />
        </UTooltip>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          :aria-label="`Remove ${connection.name}`"
          :disabled="connection.id === 'local' || !desktop.native || desktop.busy || desktop.settingsDirty"
          @click="removing = connection"
        />
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-heading"><h2>Add an existing instance</h2></div>
    <form class="panel-body form-stack" @submit.prevent="saveConnection">
      <p>
        View an existing server through its native API. Server settings and lifecycle remain managed on its host. Use
        HTTPS for connections outside a trusted local network.
      </p>
      <UFormField label="Name" required
        ><UInput
          v-model="name"
          placeholder="Home server"
          :maxlength="100"
          required
          :disabled="!desktop.native || desktop.busy"
        /></UFormField
      ><UFormField label="API URL"
        ><UInput
          v-model="baseURL"
          :placeholder="instanceURLPlaceholder"
          type="url"
          required
          :disabled="!desktop.native || desktop.busy"
        /></UFormField
      ><UFormField label="API / dashboard token"
        ><UInput
          v-model="apiKey"
          type="password"
          autocomplete="off"
          placeholder="Optional"
          :disabled="!desktop.native || desktop.busy"
        /></UFormField
      >
      <div class="actions">
        <UButton type="submit" :disabled="!canSave">Save connection</UButton>
        <UButton v-if="dirty" color="neutral" variant="ghost" :disabled="desktop.busy" @click="cancel">Cancel</UButton>
      </div>
    </form>
  </div>
  <ConnectionEditor v-model="editing" @dirty="editDirty = $event" />
  <UModal
    :open="Boolean(removing)"
    :content="confirmationContent"
    title="Remove saved connection?"
    :description="`Remove ${removing?.name ?? 'this connection'} from TRAWL? Its server and data are kept.`"
    @update:open="!$event && (removing = undefined)"
  >
    <template #body><p v-if="desktop.error" class="notice error" role="alert">{{ desktop.error }}</p></template>
    <template #footer
      ><UButton color="neutral" variant="ghost" :disabled="desktop.busy" @click="removing = undefined">Cancel</UButton
      ><UButton color="error" :disabled="desktop.busy" data-confirm-default @click="remove"
        >Remove connection</UButton
      ></template
    >
  </UModal>
</template>

<style scoped>
.connection-address {
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 3px;
}
.connection-address:hover,
.connection-address:focus-visible {
  color: var(--ui-primary);
  text-decoration-color: currentColor;
}
</style>
