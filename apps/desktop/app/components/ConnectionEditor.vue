<script setup lang="ts">
import type { Connection } from "@trawl/config/catalog"
import { connectionChanges } from "~/utils/connections"
import { LocalizedError, t } from "~/utils/localization"

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
      desktop.setError(new LocalizedError("ui.thisConnectionIsNoLongerAvailable"))
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
  <AppDialog
    :open="Boolean(connection)"
    :title="t('ui.editConnection')"
    :description="local ? t('ui.renameTheServerManagedOnThisDevice') : t('ui.updateTheSavedNameApiUrlOrAccess')"
    :dismissible="!desktop.busy"
    @update:open="if (!$event) connection = undefined;"
  >
    <template #body>
      <form id="edit-connection" class="form-stack" @submit.prevent="save">
        <UFormField :label="t('ui.name')" required
          ><UInput
            v-model="name"
            :placeholder="t('ui.homeServer')"
            :maxlength="100"
            required
            :disabled="desktop.busy"
          /></UFormField
        >
        <template v-if="!local">
          <UFormField :label="t('ui.apiUrl')" required
            ><UInput
              v-model="baseURL"
              :placeholder="instanceURLPlaceholder"
              type="url"
              required
              :disabled="desktop.busy"
            /></UFormField
          >
          <UFormField :label="t('ui.apiDashboardToken')"
            ><UInput
              v-model="apiKey"
              type="password"
              autocomplete="off"
              :placeholder="connection?.apiKey ? t('ui.leaveBlankToKeepTheCurrentToken') : t('ui.optional')"
              :disabled="desktop.busy || removeKey"
            /></UFormField
          >
          <UCheckbox
            v-if="connection?.apiKey"
            v-model="removeKey"
            :label="t('ui.removeTheSavedToken')"
            :disabled="desktop.busy"
          />
        </template>
        <p v-if="desktop.error" class="notice error" role="alert">{{ desktop.error }}</p>
      </form>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :disabled="desktop.busy" @click="cancel">{{ t("ui.cancel") }}</UButton>
      <UButton
        type="submit"
        form="edit-connection"
        :disabled="!desktop.native || desktop.busy || !dirty || !name.trim() || (!local && !baseURL.trim())"
        >{{
          t("ui.saveChanges")
        }}</UButton
      >
    </template>
  </AppDialog>
</template>
