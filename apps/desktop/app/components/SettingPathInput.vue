<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core"
import { nativeErrorMessage, t } from "~/utils/localization"

const value = defineModel<string>({ required: true })
const { name, directory, disabled } = defineProps<{ name: string; directory?: boolean; disabled?: boolean }>()
const desktop = useDesktopStore()
const choosing = shallowRef(false)
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})
async function choose() {
  choosing.value = true
  try {
    const path = await invoke<string | null>("choose_setting_path", { name, current: value.value })
    if (!disposed && path !== null) value.value = path
  } catch (cause) {
    if (!disposed)
      useToast().add({ title: t("ui.couldNotChooseAPath"), description: nativeErrorMessage(cause), color: "error" })
  } finally {
    choosing.value = false
  }
}
</script>
<template>
  <UInput
    v-model="value"
    :disabled="disabled || choosing"
    :placeholder="t('ui.optional')"
    autocomplete="off"
    class="w-full"
    :ui="{ trailing: 'p-0', base: value && !desktop.mobile ? 'pe-17' : undefined }"
  >
    <template #trailing>
      <UButton
        v-if="value"
        icon="i-lucide-x"
        color="neutral"
        variant="link"
        :disabled="disabled || choosing"
        :aria-label="directory ? t('ui.clearDirectoryPath') : t('ui.clearFilePath')"
        @click="value = ''"
      />
      <UButton
        v-if="!desktop.mobile"
        :icon="directory ? 'i-lucide-folder-open' : 'i-lucide-upload'"
        color="neutral"
        variant="link"
        :loading="choosing"
        :disabled="disabled || choosing"
        :aria-label="directory ? t('ui.chooseDirectory') : t('ui.chooseFile')"
        @click="choose"
      />
    </template>
  </UInput>
</template>
