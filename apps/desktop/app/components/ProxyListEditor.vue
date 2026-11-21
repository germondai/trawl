<script setup lang="ts">
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { t } from "~/utils/localization"

const model = defineModel<string>({ required: true })
const { disabled } = defineProps<{ disabled?: boolean }>()
const open = shallowRef(false)
useNavigationModal(open, false)
const count = computed(() => model.value.split(",").filter((value) => value.trim()).length)
const lines = shallowRef(model.value.split(",").join("\n"))
const serialize = (value: string) =>
  value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .join(",")
watch(lines, (value) => {
  model.value = serialize(value)
})
watch(model, (value) => {
  if (value !== serialize(lines.value)) lines.value = value.split(",").join("\n")
})
</script>
<template>
  <div class="proxy-editor">
    <p class="text-sm muted">{{ t("counts.configuredProxies", { count }) }}</p>
    <UButton
      class="settings-editor-button"
      icon="i-lucide-settings-2"
      color="neutral"
      variant="outline"
      :disabled="disabled"
      @click="open = true"
      >{{
        t("ui.manageProxyUrls")
      }}</UButton
    >
  </div>
  <AppDialog
    v-model:open="open"
    :title="t('ui.upstreamProxyUrls')"
    :description="t('ui.oneUrlPerLineSupportsHttpHttpsAnd')"
  >
    <template #body>
      <UTextarea
        v-model="lines"
        :rows="9"
        :maxlength="8192"
        class="mono w-full"
        placeholder="http://user:password@host:port"
        :aria-label="t('ui.proxyUrlsOnePerLine')"
        :disabled="disabled"
        autocomplete="off"
      />
    </template>
    <template #footer><UButton @click="open = false">{{ t("ui.done") }}</UButton></template>
  </AppDialog>
</template>
