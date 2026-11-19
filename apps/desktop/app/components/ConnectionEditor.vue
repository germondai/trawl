<script setup lang="ts">
import type { Connection } from "@trawl/config/catalog"
import { connectionChanges } from "~/utils/connections"

const connection = defineModel<Connection>()
const emit = defineEmits<{ dirty: [value: boolean] }>()
const desktop = useDesktopStore()
const name = shallowRef("")
const baseURL = shallowRef("")
const apiKey = shallowRef("")
const removeKey = shallowRef(false)
let draftId: string | undefined
const local = computed(() => connection.value?.id === "local")
const instanceURLPlaceholder = "https://trawl.example.com"
watch(
  connection,
  (value) => {
    if (!value || value.id === draftId) return
    draftId = value.id
    name.value = value.name
    baseURL.value = value.baseURL
    apiKey.value = ""
    removeKey.value = false
  },
  { immediate: true },
)
const dirty = computed(() =>
  Boolean(
    connection.value &&
      (name.value !== connection.value.name ||
        (!local.value && (baseURL.value !== connection.value.baseURL || apiKey.value || removeKey.value))),
  ),
)
watch(dirty, (value) => emit("dirty", value), { flush: "sync" })
onScopeDispose(() => emit("dirty", false))
function cancel() {
  draftId = undefined
  connection.value = undefined
}
async function save() {
  const previous = connection.value
  if (!previous || !name.value.trim() || (!local.value && !baseURL.value.trim())) return
  const config = structuredClone(toRaw(desktop.config))
  if (local.value) config.desktop.localName = name.value.trim()
  else {
    const index = config.desktop.connections.findIndex(({ id }) => id === previous.id)
    if (index < 0) {
      desktop.error = "This connection is no longer available"
      return
    }
    config.desktop.connections[index] = connectionChanges(previous, {
      name: name.value,
      baseURL: baseURL.value,
      apiKey: apiKey.value,
      removeKey: removeKey.value,
    })
  }
  if (await desktop.save(config)) cancel()
}
</script>
<template>
  <UModal
    :open="Boolean(connection)"
    title="Edit connection"
    :description="
      local ? 'Rename the server managed on this device.' : 'Update the saved name, API URL or access token.'
    "
    :dismissible="!desktop.busy"
    @update:open="if (!$event) connection = undefined;"
  >
    <template #body>
      <form id="edit-connection" class="form-stack" @submit.prevent="save">
        <UFormField label="Name" required
          ><UInput
            v-model="name"
            placeholder="Home server"
            :maxlength="100"
            required
            :disabled="desktop.busy"
          /></UFormField
        >
        <template v-if="!local">
          <UFormField label="API URL" required
            ><UInput
              v-model="baseURL"
              :placeholder="instanceURLPlaceholder"
              type="url"
              required
              :disabled="desktop.busy"
            /></UFormField
          >
          <UFormField label="API / dashboard token"
            ><UInput
              v-model="apiKey"
              type="password"
              autocomplete="off"
              :placeholder="connection?.apiKey ? 'Leave blank to keep the current token' : 'Optional'"
              :disabled="desktop.busy || removeKey"
            /></UFormField
          >
          <UCheckbox
            v-if="connection?.apiKey"
            v-model="removeKey"
            label="Remove the saved token"
            :disabled="desktop.busy"
          />
        </template>
        <p v-if="desktop.error" class="notice error" role="alert">{{ desktop.error }}</p>
      </form>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :disabled="desktop.busy" @click="cancel">Cancel</UButton>
      <UButton
        type="submit"
        form="edit-connection"
        :disabled="!desktop.native || desktop.busy || !dirty || !name.trim() || (!local && !baseURL.trim())"
        >Save changes</UButton
      >
    </template>
  </UModal>
</template>
