<script setup lang="ts">
import { t } from "~/utils/localization"

const model = defineModel<string>({ required: true })
const { position, fieldId, disabled, removable } = defineProps<{
  position: number
  fieldId: string
  disabled?: boolean
  removable: boolean
}>()
const emit = defineEmits<{ remove: [] }>()
</script>
<template>
  <UFormField :label="t('ui.server', { p0: position })" :name="fieldId">
    <div class="dns-editor-address">
      <UInput
        v-model="model"
        :id="fieldId"
        class="w-full mono"
        :maxlength="2048"
        :aria-label="t('ui.dnsServer', { p0: position })"
        :placeholder="t('ui.1001OrHttpsResolverExample')"
        autocomplete="off"
        :disabled="disabled"
      />
      <UButton
        icon="i-lucide-trash-2"
        color="neutral"
        variant="ghost"
        :aria-label="t('ui.removeDnsServer', { p0: position })"
        :disabled="disabled || !removable"
        @click="emit('remove')"
      />
    </div>
  </UFormField>
</template>
