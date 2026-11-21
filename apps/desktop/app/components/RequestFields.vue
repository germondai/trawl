<script setup lang="ts">
import { LocalizedError, nativeErrorMessage, t } from "~/utils/localization"
import { readRequestFile } from "~/utils/request-body"
import {
  emptyRequestField,
  type FieldFormat,
  parseRequestFields,
  type RequestField,
  serializeRequestFields,
} from "~/utils/request-fields"

const value = defineModel<string>({ required: true })
const rows = defineModel<RequestField[]>("rows", { required: true })
const props = defineProps<{ format: FieldFormat; label: string; disabled?: boolean; allowFiles?: boolean }>()
const emit = defineEmits<{ invalid: [message: string] }>()
const mode = shallowRef("table")
const failure = shallowRef<unknown>("")
const error = computed(() => nativeErrorMessage(failure.value))
const reading = shallowRef(0)
const hasFiles = computed(() => rows.value.some((row) => row.file))
const rawDraft = shallowRef(value.value)
let editingRaw = false
async function editRaw(text: string) {
  rawDraft.value = text
  editingRaw = true
  value.value = text
  await nextTick()
  editingRaw = false
}
watch(mode, () => {
  rawDraft.value = value.value
})
watch([error, reading], ([message, count]) => emit("invalid", count ? t("ui.readingFile") : message), {
  immediate: true,
})
watch(
  value,
  (text) => {
    if (!editingRaw) rawDraft.value = text
    let serialized: string | undefined
    try {
      serialized = serializeRequestFields(rows.value, props.format)
    } catch {}
    if (serialized === text) {
      if (!rows.value.length) rows.value = [emptyRequestField()]
      failure.value = ""
      return
    }
    try {
      const next = parseRequestFields(text, props.format)
      rows.value = next.length ? next : [emptyRequestField()]
      failure.value = ""
    } catch (cause) {
      failure.value = cause instanceof Error ? cause : new LocalizedError("ui.invalidFields")
      mode.value = "raw"
    }
  },
  { immediate: true, flush: "sync" },
)
function commit() {
  try {
    value.value = serializeRequestFields(rows.value, props.format)
    failure.value = ""
  } catch (cause) {
    failure.value = cause instanceof Error ? cause : new LocalizedError("ui.invalidFields")
  }
}
function remove(index: number) {
  rows.value.splice(index, 1)
  if (!rows.value.length) rows.value.push(emptyRequestField())
  commit()
}
const fileSelections = new WeakMap<RequestField, number>()
function clearFile(row: RequestField) {
  fileSelections.set(row, (fileSelections.get(row) ?? 0) + 1)
  row.file = undefined
  row.value = ""
  commit()
}
let disposed = false
onScopeDispose(() => {
  disposed = true
})
async function chooseFile(row: RequestField, file?: File) {
  if (!file) return
  const previous = row.file
  const generation = (fileSelections.get(row) ?? 0) + 1
  fileSelections.set(row, generation)
  reading.value++
  try {
    const selected = await readRequestFile(file)
    if (!disposed && rows.value.includes(row) && row.file === previous && fileSelections.get(row) === generation) {
      row.file = selected
      row.value = ""
      commit()
    }
  } catch (cause) {
    if (!disposed && rows.value.includes(row) && row.file === previous && fileSelections.get(row) === generation)
      failure.value = cause instanceof Error ? cause : new LocalizedError("ui.unableToReadFile")
  } finally {
    reading.value--
  }
}
function upload(event: MouseEvent) {
  const input = (event.currentTarget as HTMLElement)
    .closest(".field-value")
    ?.querySelector<HTMLInputElement>("input[type=file]")
  input?.click()
}
function dragOver(event: DragEvent) {
  if (!props.allowFiles || props.disabled || (event.currentTarget as HTMLElement).closest("fieldset[disabled]")) return
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
}
function dropFile(row: RequestField, event: DragEvent) {
  if (!props.allowFiles || props.disabled || (event.currentTarget as HTMLElement).closest("fieldset[disabled]")) return
  if (!event.dataTransfer?.files.length) return
  event.preventDefault()
  if (event.dataTransfer.files.length > 1) failure.value = new LocalizedError("ui.chooseOneFilePerRow")
  else void chooseFile(row, event.dataTransfer.files[0])
}
</script>
<template>
  <fieldset class="request-fields" :disabled="disabled" :aria-label="label">
    <div class="field-editor-heading">
      <span>{{ label }}</span>
      <div class="actions">
        <UButton
          color="neutral"
          :variant="mode === 'table' ? 'soft' : 'ghost'"
          :aria-pressed="mode === 'table'"
          :disabled="Boolean(error)"
          @click="mode = 'table'"
          >{{
            t("ui.table")
          }}</UButton
        >
        <UButton
          color="neutral"
          :variant="mode === 'raw' ? 'soft' : 'ghost'"
          :aria-pressed="mode === 'raw'"
          :disabled="hasFiles || (Boolean(error) && mode === 'table')"
          @click="mode = 'raw'"
          >{{
            format === "headers" ? t("ui.rawJson") : t("ui.bulk")
          }}</UButton
        >
      </div>
    </div>
    <template v-if="mode === 'table'">
      <div class="field-editor-scroll">
        <table class="field-editor-table">
          <thead>
            <tr>
              <th><span class="sr-only">{{ t("ui.enabled") }}</span></th>
              <th>{{ t("ui.key") }}</th>
              <th>{{ t("ui.value") }}</th>
              <th>{{ t("ui.description") }}</th>
              <th><span class="sr-only">{{ t("ui.remove2") }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in rows" :key="index">
              <td>
                <UCheckbox
                  v-model="row.enabled"
                  :ui="{ root: 'justify-center' }"
                  :aria-label="t('ui.enableRow', { p0: label, p1: index + 1 })"
                  @update:model-value="commit"
                />
              </td>
              <td>
                <UInput
                  v-model="row.key"
                  variant="none"
                  class="w-full"
                  :placeholder="t('ui.key')"
                  :aria-label="t('fields.key', { label, row: index + 1 })"
                  :maxlength="4096"
                  autocomplete="off"
                  spellcheck="false"
                  @update:model-value="commit"
                />
              </td>
              <td class="field-value" @dragover="dragOver" @drop="dropFile(row, $event)">
                <input
                  v-if="allowFiles"
                  type="file"
                  hidden
                  :aria-label="t('fields.file', { label, row: index + 1 })"
                  @change="
                    chooseFile(row, ($event.target as HTMLInputElement).files?.[0]);
                    ($event.target as HTMLInputElement).value = '';
                  "
                />
                <UInput
                  :model-value="row.file?.name ?? row.value"
                  :readonly="Boolean(row.file)"
                  :ui="{ trailing: 'gap-1', base: allowFiles && row.file ? 'pe-16' : undefined }"
                  variant="none"
                  class="w-full"
                  :placeholder="t('ui.value')"
                  :aria-label="t('fields.value', { label, row: index + 1 })"
                  :maxlength="8192"
                  autocomplete="off"
                  spellcheck="false"
                  @update:model-value="
                    row.value = $event;
                    commit();
                  "
                >
                  <template v-if="allowFiles" #trailing>
                    <AppTooltip v-if="row.file" :text="t('ui.removeFile')">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-x"
                        size="xs"
                        :disabled="disabled"
                        :aria-label="t('ui.removeFile2', { p0: label, p1: index + 1 })"
                        @click="clearFile(row)"
                      />
                    </AppTooltip>
                    <AppTooltip :text="row.file ? t('ui.replaceFile') : t('ui.uploadFileOrDropItIntoThisField')">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-upload"
                        size="xs"
                        :disabled="disabled"
                        :aria-label="t('ui.uploadFile', { p0: label, p1: index + 1 })"
                        @click="upload"
                      />
                    </AppTooltip>
                  </template>
                </UInput>
              </td>
              <td>
                <UInput
                  v-model="row.description"
                  variant="none"
                  class="w-full"
                  :placeholder="t('ui.description')"
                  :aria-label="t('fields.description', { label, row: index + 1 })"
                  :maxlength="512"
                />
              </td>
              <td>
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  :aria-label="t('ui.removeRow', { p0: label, p1: index + 1 })"
                  @click="remove(index)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <UButton
        class="self-start"
        color="neutral"
        variant="ghost"
        icon="i-lucide-plus"
        :disabled="rows.length >= 100"
        @click="rows.push(emptyRequestField())"
        >{{
          t("ui.addRow")
        }}</UButton
      >
    </template>
    <UTextarea
      v-else
      :model-value="rawDraft"
      :placeholder="
        format === 'headers'
          ? '{\n  &quot;Accept&quot;: &quot;application/json&quot;\n}'
          : 'name=value\ntag=first\ntag=second'
      "
      :aria-label="t(format === 'headers' ? 'fields.json' : 'fields.bulk', { label })"
      :maxlength="32768"
      :rows="6"
      class="w-full mono"
      autocomplete="off"
      spellcheck="false"
      @update:model-value="editRaw"
    />
    <p v-if="error" class="text-error text-sm" role="alert">{{ error }}</p>
    <p v-if="allowFiles" class="text-xs muted">
      {{ t("ui.filesStayInThisDraftOnlyMaximum128") }}
    </p>
  </fieldset>
</template>
<style scoped>
.request-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.field-editor-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.field-editor-scroll {
  overflow-x: auto;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
}
.field-editor-table {
  width: 100%;
  min-width: 560px;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}
th {
  color: var(--ui-text-muted);
  font-weight: 500;
  text-align: left;
  padding: 8px 12px;
}
td {
  padding: 4px;
  vertical-align: middle;
}
td,
th {
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
}
tr:last-child td {
  border-bottom: 0;
}
td:last-child,
th:last-child {
  border-right: 0;
}
td:first-child,
th:first-child,
td:last-child,
th:last-child {
  width: 40px;
  text-align: center;
}
</style>
