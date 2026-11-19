<script setup lang="ts">
import {
  defaults,
  type Environment,
  type ResourceProfileValues,
  resourcePresets,
  resourceProfileKeys,
  settingByName,
} from "@trawl/config/catalog"
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { applyResourceProfile, resourceOverrides, resourceProfileName } from "~/utils/resource-profiles"
import { settingLabel, settingValueHint } from "~/utils/settings"

const environment = defineModel<Environment>("environment", { required: true })
const desktop = useDesktopStore()
const selected = shallowRef<keyof typeof resourcePresets>()
const undo = shallowRef<ResourceProfileValues>()
useNavigationModal(selected, undefined)
const current = computed(() => resourceProfileName(environment.value, desktop.inherited, desktop.sources))
const values = computed(() => (selected.value ? resourcePresets[selected.value] : undefined))
const rows = computed(() =>
  resourceProfileKeys.map((key) => {
    const setting = settingByName.get(key)!
    const locked = desktop.sources[key] === "environment"
    const before = locked
      ? (desktop.inherited[key] ?? defaults[key]!)
      : (environment.value[key] ?? desktop.inherited[key] ?? defaults[key]!)
    const after = locked ? before : (values.value?.[key] ?? desktop.inherited[key] ?? defaults[key]!)
    return {
      key,
      label: settingLabel(setting),
      before: settingValueHint(setting, before) || before,
      after: settingValueHint(setting, after) || after,
      locked,
      configured: values.value?.[key],
      inherited: values.value?.[key] === undefined,
      changed: environment.value[key] !== values.value?.[key],
    }
  }),
)
function apply() {
  if (!values.value) return
  undo.value = resourceOverrides(environment.value)
  environment.value = applyResourceProfile(environment.value, values.value)
  selected.value = undefined
}
function revert() {
  if (!undo.value) return
  environment.value = applyResourceProfile(environment.value, undo.value)
  undo.value = undefined
}
</script>
<template>
  <section class="profile-strip">
    <div>
      <strong>Resource profile <UBadge color="neutral" variant="subtle" size="sm">{{ current }}</UBadge></strong>
      <p>
        Preview changes before applying. Profiles change browser startup, idle timeout and WAF diagnostics; other
        settings stay as configured.
      </p>
      <p v-if="undo" class="text-xs muted">You can undo the last profile change, including after saving.</p>
    </div>
    <div class="actions">
      <UButton
        color="neutral"
        variant="outline"
        :disabled="!desktop.native || desktop.busy"
        @click="selected = 'balanced'"
        >Standard</UButton
      >
      <UButton
        color="neutral"
        variant="outline"
        :disabled="!desktop.native || desktop.busy"
        @click="selected = 'economy'"
        >Economy</UButton
      >
      <UButton
        v-if="undo"
        icon="i-lucide-undo-2"
        color="neutral"
        variant="ghost"
        :disabled="desktop.busy"
        @click="revert"
        >Undo profile</UButton
      >
    </div>
  </section>
  <UModal
    :open="Boolean(selected)"
    title="Preview resource profile"
    description="Changes remain a draft until you save Server settings. Environment overrides take priority."
    @update:open="if (!$event) selected = undefined;"
  >
    <template #body
      ><div class="profile-table">
        <table class="request-table profile-preview">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Current</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <td>{{ row.label }}</td>
              <td>{{ row.before }}</td>
              <td>
                {{ row.after
                }}<small class="block muted">{{
                  row.locked
                    ? "Environment override"
                    : !row.changed
                      ? "Unchanged"
                      : row.inherited
                        ? "Inherited"
                        : "Override"
                }}</small><small v-if="row.locked && row.configured !== undefined" class="block muted"
                  >Saved value: {{ row.configured }}</small
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <template #footer
      ><UButton color="neutral" variant="outline" @click="selected = undefined">Cancel</UButton
      ><UButton :disabled="desktop.busy" @click="apply"
        >Use {{ selected === "balanced" ? "Standard" : "Economy" }}</UButton
      ></template
    >
  </UModal>
</template>
<style scoped>
.profile-table {
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
}
.profile-preview {
  width: 100%;
  min-width: 0;
  table-layout: fixed;
}
.profile-preview th,
.profile-preview td {
  white-space: normal;
  overflow-wrap: anywhere;
  padding: 12px 8px;
  vertical-align: top;
}
.profile-preview th:first-child {
  width: 44%;
}
</style>
