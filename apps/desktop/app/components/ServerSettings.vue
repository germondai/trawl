<script setup lang="ts">
import type { Setting, UserConfig } from "@trawl/config/catalog"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import type { SettingTarget } from "~/utils/setting-navigation"
import { rebaseSettingsDraft, sectionFor, settingLabel, settingSections, settingValueHint } from "~/utils/settings"

const props = defineProps<{ focusSetting?: SettingTarget }>()

const emit = defineEmits<{ focused: [] }>()
const desktop = useDesktopStore()
const query = shallowRef("")
const selected = shallowRef<(typeof settingSections)[number]["id"]>("general")
useNavigationSelection("settings-category", selected)
const { highlighted } = useSettingFocus(
  () => props.focusSetting,
  () => desktop.catalog,
  query,
  selected,
  () => emit("focused"),
)
const draft = ref<Record<string, string>>({ ...desktop.config.env })
const baseline = ref<Record<string, string>>({ ...desktop.config.env })
const changed = computed(() =>
  [...new Set([...Object.keys(draft.value), ...Object.keys(baseline.value)])].filter(
    (name) => draft.value[name] !== baseline.value[name],
  ),
)
const changeCount = computed(() => changed.value.length)
const dirty = computed(() => changeCount.value > 0)
watch(
  dirty,
  (value) => {
    desktop.settingsDirty = value
  },
  { flush: "sync" },
)
onBeforeUnmount(() => {
  desktop.settingsDirty = false
})
watch(
  () => desktop.config.env,
  (env) => {
    const next = rebaseSettingsDraft(draft.value, baseline.value, env)
    baseline.value = { ...env }
    draft.value = next
  },
  { deep: true },
)
const sections = computed(() =>
  settingSections.map((section) => ({
    ...section,
    settings: desktop.catalog.filter((setting) => sectionFor(setting) === section.id),
  })),
)
const visible = computed(() =>
  sections.value
    .map((section) => ({
      ...section,
      settings: section.settings.filter((setting) =>
        `${setting.name} ${settingLabel(setting)} ${setting.description}`
          .toLowerCase()
          .includes(query.value.trim().toLowerCase()),
      ),
    }))
    .filter((section) => section.settings.length && (query.value.trim() || section.id === selected.value)),
)
const resultCount = computed(() => visible.value.reduce((count, section) => count + section.settings.length, 0))
const groupItems = computed(() => sections.value.map((section) => ({ label: section.label, value: section.id })))
const value = (setting: Setting) => draft.value[setting.name] ?? desktop.inherited[setting.name] ?? setting.default
function change(name: string, next: unknown) {
  draft.value[name] = String(next ?? "")
}
function reset(name: string) {
  delete draft.value[name]
}
function discard() {
  baseline.value = { ...desktop.config.env }
  draft.value = { ...desktop.config.env }
}
async function save() {
  const config: UserConfig = {
    ...desktop.config,
    env: { ...draft.value },
  }
  if (await desktop.save(config)) discard()
}
</script>
<template>
  <ResourceProfiles v-if="!desktop.mobile" v-model:environment="draft" />
  <div class="settings-toolbar">
    <UInput
      v-model="query"
      leading-icon="i-lucide-search"
      :ui="{ trailing: 'p-0' }"
      placeholder="Search settings"
      aria-label="Search settings"
      class="settings-search"
      ><template v-if="query" #trailing
        ><UButton
          v-if="query"
          color="neutral"
          variant="link"
          icon="i-lucide-x"
          class="search-clear"
          aria-label="Clear settings search"
          @click="query = ''"
        /></template
      ></UInput
    ><span class="settings-count">{{
      query.trim() ? `${resultCount} matches` : `${desktop.catalog.length} settings`
    }}</span>
  </div>
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="Setting categories">
      <button
        v-for="section in sections"
        :key="section.id"
        type="button"
        :class="{ active: selected === section.id && !query.trim() }"
        :aria-current="selected === section.id && !query.trim() ? 'page' : undefined"
        @click="
          selected = section.id;
          query = '';
        "
      >
        <span>{{ section.label }}</span><span>{{ section.settings.length }}</span>
      </button>
    </nav>
    <div class="settings-mobile-group">
      <USelect v-model="selected" :items="groupItems" aria-label="Setting category" @update:model-value="query = ''" />
    </div>
    <div class="settings-sections">
      <section v-for="section in visible" :key="section.id" class="panel settings-section" :aria-label="section.label">
        <div class="panel-heading">
          <div>
            <h2>{{ section.label }}</h2>
            <p>{{ section.description }}</p>
          </div>
        </div>
        <UFormField
          v-for="setting in section.settings"
          :key="setting.name"
          :id="`setting-${setting.name}`"
          :data-target="highlighted === setting.name"
          :name="setting.name"
          :label="settingLabel(setting)"
          :description="setting.description"
          :error="desktop.error.startsWith(`${setting.name} `) ? desktop.error : undefined"
          class="setting-row"
          :ui="{ wrapper: 'setting-copy', container: 'setting-control', description: 'setting-description' }"
        >
          <template #description
            ><SettingText :text="setting.description" />
            <code class="setting-name mono">{{ setting.name }}</code></template
          >
          <USwitch
            v-if="setting.kind === 'boolean'"
            :model-value="value(setting) === 'true'"
            :disabled="desktop.busy || !desktop.native"
            @update:model-value="change(setting.name, $event)"
          />
          <USelect
            v-else-if="setting.kind === 'enum'"
            :model-value="value(setting)"
            :items="[...(setting.choices ?? [])]"
            :disabled="desktop.busy || !desktop.native"
            @update:model-value="change(setting.name, $event)"
          />
          <UTextarea
            v-else-if="setting.kind === 'json'"
            :model-value="value(setting)"
            :rows="3"
            class="w-full mono"
            :disabled="desktop.busy || !desktop.native"
            @update:model-value="change(setting.name, $event)"
          />
          <UInput
            v-else
            :model-value="value(setting)"
            :type="setting.secret ? 'password' : setting.kind === 'integer' ? 'number' : 'text'"
            :placeholder="setting.secret ? 'Not configured' : 'Optional'"
            :min="setting.min"
            :max="setting.max"
            autocomplete="off"
            :disabled="desktop.busy || !desktop.native"
            @update:model-value="change(setting.name, $event)"
          />
          <div class="setting-meta">
            <span>{{
              desktop.sources[setting.name] === "environment"
                ? "Environment override"
                : settingValueHint(setting, value(setting))
            }}</span><UButton
              v-if="setting.name in draft"
              size="xs"
              color="neutral"
              variant="link"
              :disabled="desktop.busy || !desktop.native"
              :aria-label="`Use inherited value for ${settingLabel(setting)}`"
              @click="reset(setting.name)"
              >Reset</UButton
            ><span v-else class="setting-source">{{
              desktop.sources[setting.name] === "environment" ? "Environment" : "Inherited"
            }}</span>
          </div>
        </UFormField>
      </section>
      <div v-if="!visible.length" class="empty panel">No settings match “{{ query }}”</div>
    </div>
  </div>
  <Teleport to="#settings-save-slot" defer>
    <section v-if="dirty" class="settings-save-bar" aria-label="Unsaved settings">
      <span
        >{{ changeCount }}
        unsaved {{ changeCount === 1 ? "change" : "changes"
        }}<small>Restart the server after saving to apply changes.</small></span
      >
      <div class="actions">
        <UButton color="neutral" variant="ghost" :disabled="desktop.busy" @click="discard">Reset</UButton
        ><UButton :disabled="desktop.busy || !desktop.native" :loading="desktop.busy" @click="save"
          >Save changes</UButton
        >
      </div>
    </section>
  </Teleport>
</template>
