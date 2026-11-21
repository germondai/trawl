<script setup lang="ts">
import { type Setting, type UserConfig } from "@trawl/config/catalog"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import { t } from "~/utils/localization"
import type { SettingTarget } from "~/utils/setting-navigation"
import {
  applyDnsSettings,
  groupedSettings,
  rebaseSettingsDraft,
  settingDescription,
  settingLabel,
  type settingSections,
  settingValueHint,
} from "~/utils/settings"

const props = defineProps<{ focusSetting?: SettingTarget }>()

const emit = defineEmits<{ focused: [] }>()
const desktop = useDesktopStore()
const sections = computed(() => groupedSettings(desktop.catalog.filter((setting) => setting.name !== "DNS_SERVERS")))
const query = shallowRef("")
const selected = shallowRef<(typeof settingSections)[number]["id"]>("general")
const navigation = useNavigationSelection("settings-category", selected, {
  valid: (value) => !sections.value.length || sections.value.some((section) => section.id === value),
})
watchEffect(() => {
  const first = sections.value[0]
  if (first && !sections.value.some((section) => section.id === selected.value)) {
    navigation?.dropSelection("settings-category", selected.value, first.id)
    selected.value = first.id
  }
})
const { highlighted } = useSettingFocus(
  () =>
    props.focusSetting?.name === "DNS_SERVERS" ? { ...props.focusSetting, name: "DNS_RESOLVER" } : props.focusSetting,
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
const visible = computed(() =>
  sections.value
    .map((section) => ({
      ...section,
      settings: section.settings.filter((setting) =>
        `${setting.name} ${settingLabel(setting)} ${settingDescription(setting)} ${setting.name === "DNS_RESOLVER" ? `DNS_SERVERS ${t("settings.DNS_SERVERS.label")} ${t("settings.DNS_SERVERS.description")}` : ""}`
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
  if (name === "DNS_RESOLVER") delete draft.value.DNS_SERVERS
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
      :placeholder="t('ui.searchSettings')"
      :aria-label="t('ui.searchSettings')"
      data-type-focus
      data-tour="settings-search"
      class="settings-search"
      ><template v-if="query" #trailing
        ><UButton
          v-if="query"
          color="neutral"
          variant="link"
          icon="i-lucide-x"
          class="search-clear"
          :aria-label="t('ui.clearSettingsSearch')"
          @click="query = ''"
        /></template
      ></UInput
    ><span class="settings-count">{{
      query.trim()
        ? t("counts.matches", { count: resultCount })
        : t("counts.settings", { count: desktop.catalog.length })
    }}</span>
  </div>
  <div class="settings-layout">
    <nav class="settings-nav" :aria-label="t('ui.settingCategories')">
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
      <USelect
        v-model="selected"
        :items="groupItems"
        :aria-label="t('ui.settingCategory')"
        @update:model-value="query = ''"
      />
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
          :description="settingDescription(setting)"
          :error="desktop.error.startsWith(`${setting.name} `) ? desktop.error : undefined"
          class="setting-row"
          :ui="{ wrapper: 'setting-copy', container: 'setting-control', description: 'setting-description' }"
        >
          <template #description
            ><SettingText :text="settingDescription(setting)" />
            <code class="setting-name mono">{{ setting.name }}</code></template
          >
          <DnsSettingsEditor
            v-if="setting.name === 'DNS_RESOLVER'"
            :resolver="value(setting)"
            :servers="draft.DNS_SERVERS ?? desktop.inherited.DNS_SERVERS ?? ''"
            :focus-servers="props.focusSetting?.name === 'DNS_SERVERS' ? props.focusSetting.revision : undefined"
            :disabled="desktop.busy || !desktop.native"
            @change="draft = applyDnsSettings(draft, desktop.inherited, $event)"
          />
          <USwitch
            v-else-if="setting.kind === 'boolean'"
            :aria-label="settingLabel(setting)"
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
          <ProxyListEditor
            v-else-if="setting.name === 'PROXY_URL' || setting.name === 'RESIDENTIAL_PROXY_URL'"
            :model-value="value(setting)"
            :disabled="desktop.busy || !desktop.native"
            @update:model-value="change(setting.name, $event)"
          />
          <SettingPathInput
            v-else-if="
              [
                'MITM_CA_DIR',
                'METRICS_DB_PATH',
                'PROXY_LIST_FILE',
                'RESIDENTIAL_PROXY_LIST_FILE',
                'FFMPEG_PATH',
              ].includes(setting.name)
            "
            :name="setting.name"
            :model-value="value(setting)"
            :directory="setting.name === 'MITM_CA_DIR'"
            :disabled="desktop.busy || !desktop.native"
            @update:model-value="change(setting.name, $event)"
          />
          <UInput
            v-else
            :model-value="value(setting)"
            :type="setting.secret ? 'password' : setting.kind === 'integer' ? 'number' : 'text'"
            :placeholder="setting.secret ? t('ui.notConfigured') : t('ui.optional')"
            :min="setting.min"
            :max="setting.max"
            autocomplete="off"
            :disabled="desktop.busy || !desktop.native"
            @update:model-value="change(setting.name, $event)"
          />
          <div class="setting-meta">
            <span
              class="setting-hint"
              :title="
                desktop.sources[setting.name] === 'environment' ? undefined : settingValueHint(setting, value(setting))
              "
              >{{
                desktop.sources[setting.name] === "environment"
                  ? t("ui.environmentOverride")
                  : settingValueHint(setting, value(setting))
              }}</span
            ><UButton
              v-if="setting.name in draft"
              size="xs"
              color="neutral"
              variant="link"
              :disabled="desktop.busy || !desktop.native"
              :aria-label="t('ui.useInheritedValueFor', { p0: settingLabel(setting) })"
              @click="reset(setting.name)"
              >{{
                t("ui.reset")
              }}</UButton
            ><span v-else class="setting-source">{{
              desktop.sources[setting.name] === "environment" ? t("ui.environment") : t("ui.inherited")
            }}</span>
          </div>
        </UFormField>
      </section>
      <div v-if="!visible.length" class="empty panel">
        {{ query.trim() ? t("ui.noSettingsMatch", { p0: query }) : t("ui.noSettingsAreAvailableForThisInstance") }}
      </div>
    </div>
  </div>
  <Teleport to="#settings-save-slot" defer>
    <section v-if="dirty" class="settings-save-bar" :aria-label="t('ui.unsavedSettings')">
      <span
        >{{ t("counts.unsavedChanges", { count: changeCount })
        }}<small>{{ t("ui.restartTheServerAfterSavingToApplyChanges") }}</small></span
      >
      <div class="actions">
        <UButton color="neutral" variant="ghost" :disabled="desktop.busy" @click="discard">{{ t("ui.reset") }}</UButton
        ><UButton :disabled="desktop.busy || !desktop.native" :loading="desktop.busy" @click="save">{{
          t("ui.saveChanges")
        }}</UButton>
      </div>
    </section>
  </Teleport>
</template>
