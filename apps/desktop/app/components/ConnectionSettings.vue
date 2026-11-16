<script setup lang="ts">
import type { UserConfig } from "@trawl/config/catalog"

const desktop = useDesktopStore()
const name = shallowRef("")
const baseURL = shallowRef("")
const apiKey = shallowRef("")
const canSave = computed(
  () => desktop.native && !desktop.busy && Boolean(name.value.trim()) && Boolean(baseURL.value.trim()),
)
async function add() {
  if (!name.value.trim() || !baseURL.value.trim()) return
  const config = structuredClone(toRaw(desktop.config))
  config.desktop.connections.push({
    id: crypto.randomUUID(),
    name: name.value.trim(),
    baseURL: baseURL.value.trim(),
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
  })
  await desktop.save(config)
  if (!desktop.error) {
    name.value = ""
    baseURL.value = ""
    apiKey.value = ""
  }
}
async function remove(id: string) {
  const config = structuredClone(toRaw(desktop.config))
  config.desktop.connections = config.desktop.connections.filter((connection) => connection.id !== id)
  await desktop.save(config)
  if (desktop.activeId === id) await desktop.select("local")
}
async function preference(key: "closeBehavior" | "autostart" | "startServerOnLaunch", value: unknown) {
  const config = structuredClone(toRaw(desktop.config))
  if (key === "closeBehavior") config.desktop.closeBehavior = value as UserConfig["desktop"]["closeBehavior"]
  else config.desktop[key] = Boolean(value)
  await desktop.save(config)
}
</script>
<template>
  <div class="panel">
    <div class="panel-heading"><h2>Application behavior</h2></div>
    <div class="panel-body form-stack">
      <UFormField label="When the window closes"
        ><USelect
          :model-value="desktop.config.desktop.closeBehavior"
          :items="[
            { label: 'Ask me', value: 'ask' },
            { label: 'Keep running in tray', value: 'tray' },
            { label: 'Quit and stop my server', value: 'quit' },
          ]"
          :disabled="!desktop.native || desktop.busy"
          class="max-w-sm"
          @update:model-value="preference('closeBehavior', $event)"
        /></UFormField
      ><UFormField label="Start TRAWL when I sign in"
        ><USwitch
          :model-value="desktop.config.desktop.autostart"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('autostart', $event)"
        /><span class="field-description"
          >Starts the desktop application in the background. You can disable this at any time.</span
        ></UFormField
      ><UFormField label="Start the local server with the application">
        <USwitch
          :model-value="desktop.config.desktop.startServerOnLaunch"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('startServerOnLaunch', $event)"
        />
        <span class="field-description"
          >Requires the browser to be installed. The server keeps your configured Standard or Economy profile.</span
        >
      </UFormField>
    </div>
  </div>
  <div class="panel">
    <div class="panel-heading"><h2>Saved connections</h2></div>
    <div class="connection">
      <div>
        <strong>Local instance</strong>
        <p class="mono text-xs">Managed on this device</p>
      </div>
      <UButton color="neutral" variant="outline" @click="desktop.select('local')">{{
        desktop.activeId === "local" ? "Selected" : "Connect"
      }}</UButton>
    </div>
    <div v-for="connection in desktop.config.desktop.connections" :key="connection.id" class="connection">
      <div>
        <strong>{{ connection.name }}</strong>
        <p class="mono text-xs">{{ connection.baseURL }}</p>
      </div>
      <div class="actions">
        <UButton color="neutral" variant="outline" @click="desktop.select(connection.id)">Connect</UButton>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          aria-label="Remove saved connection"
          :disabled="!desktop.native"
          @click="remove(connection.id)"
        />
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-heading"><h2>Add an existing instance</h2></div>
    <div class="panel-body form-stack">
      <p>
        View an existing server through its native API. Server settings and lifecycle remain managed on its host. Use
        HTTPS for connections outside a trusted local network.
      </p>
      <UFormField label="Name"><UInput v-model="name" placeholder="Home server" /></UFormField
      ><UFormField label="API URL"
        ><UInput v-model="baseURL" placeholder="https://trawl.example.com" type="url" /></UFormField
      ><UFormField label="API / dashboard token"
        ><UInput v-model="apiKey" type="password" autocomplete="off" placeholder="Optional" /></UFormField
      >
      <div><UButton :disabled="!canSave" @click="add">Save connection</UButton></div>
    </div>
  </div>
</template>
