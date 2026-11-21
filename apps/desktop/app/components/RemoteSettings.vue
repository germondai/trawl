<script setup lang="ts">
import type { InstanceSetting } from "@trawl/client"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import { LocalizedError, t } from "~/utils/localization"
import type { SettingTarget } from "~/utils/setting-navigation"
import { groupedSettings, settingDescription, settingLabel, type settingSections } from "~/utils/settings"

const props = defineProps<{ focusSetting?: SettingTarget }>()

const emit = defineEmits<{ focused: [] }>()
const desktop = useDesktopStore()
const values = shallowRef<InstanceSetting[]>([])
const sections = computed(() => groupedSettings(values.value))
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
  () => props.focusSetting,
  () => values.value,
  query,
  selected,
  () => emit("focused"),
)
const error = useErrorMessage()
const pending = shallowRef(false)
const { revision, refresh, finish } = useRefreshRevision()
usePageRefresh(refresh)
const visible = useDocumentVisibility()
watch(
  [() => desktop.activeId, () => desktop.capabilities?.settings, visible, revision],
  async ([id, enabled, visibility, refreshCount], previous, onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => {
      finish(refreshCount)
      controller.abort()
    })
    if (id !== previous?.[0]) values.value = []
    error.value = ""
    pending.value = false
    if (!desktop.native || !enabled || visibility !== "visible") {
      finish(refreshCount)
      return
    }
    pending.value = true
    try {
      const result = await desktop.client().settings({ signal: controller.signal })
      if (!controller.signal.aborted) values.value = result.settings
    } catch (cause) {
      if (!controller.signal.aborted)
        error.value =
          cause instanceof Error || typeof cause === "string"
            ? cause
            : new LocalizedError("ui.cannotReadInstanceSettings")
    } finally {
      finish(refreshCount)
      if (!controller.signal.aborted) pending.value = false
    }
  },
  { immediate: true },
)
const filtered = computed(() =>
  sections.value
    .map((section) => ({
      ...section,
      settings: section.settings.filter((setting) =>
        `${setting.name} ${settingLabel(setting)} ${settingDescription(setting)}`
          .toLowerCase()
          .includes(query.value.trim().toLowerCase()),
      ),
    }))
    .filter((section) => section.settings.length && (query.value.trim() || section.id === selected.value)),
)
const groupItems = computed(() => sections.value.map(({ id, label }) => ({ label, value: id })))
</script>
<template>
  <div v-if="!desktop.health" class="notice">{{ t("ui.thisInstanceIsUnavailableReconnectToInspectIts") }}</div>
  <div v-else-if="!desktop.capabilities?.settings" class="notice">
    {{ t("ui.thisInstanceDoesNotOfferSettingsInspectionIt") }}
    <SettingLink name="OBSERVABILITY_ENABLED">{{ t("ui.observabilityEnabledTrue") }}</SettingLink>
    {{ t("ui.andAConfiguredDashboardToken") }}
  </div>
  <template v-else>
    <div class="settings-toolbar">
      <UInput
        v-model="query"
        leading-icon="i-lucide-search"
        :ui="{ trailing: 'p-0' }"
        :placeholder="t('ui.searchSettings')"
        :aria-label="t('ui.searchRemoteSettings')"
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
      >
      <span class="settings-count"
        >{{
          query.trim()
            ? t("counts.matches", { count: filtered.reduce((sum, section) => sum + section.settings.length, 0) })
            : t("counts.settings", { count: values.length })
        }}
        {{ t("ui.readOnly") }}</span
      >
    </div>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-else-if="pending && !values.length" class="muted" role="status">{{ t("ui.readingInstanceSettings") }}</p>
    <div v-else class="settings-layout">
      <nav class="settings-nav" :aria-label="t('ui.remoteSettingCategories')">
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
          :aria-label="t('ui.remoteSettingCategory')"
          :disabled="pending || !sections.length"
          @update:model-value="query = ''"
        />
      </div>
      <div class="settings-sections">
        <section
          v-for="section in filtered"
          :key="section.id"
          class="panel settings-section"
          :aria-label="section.label"
        >
          <div class="panel-heading">
            <div>
              <h2>{{ section.label }}</h2>
              <p>{{ section.description }}</p>
            </div>
          </div>
          <div
            v-for="setting in section.settings"
            :key="setting.name"
            :id="`setting-${setting.name}`"
            :data-target="highlighted === setting.name"
            class="setting-row"
          >
            <div class="setting-copy">
              <strong>{{ settingLabel(setting) }}</strong>
              <p class="setting-description"><SettingText :text="settingDescription(setting)" /></p>
              <code class="setting-name mono">{{ setting.name }}</code>
            </div>
            <div class="setting-control min-w-0">
              <p class="mono whitespace-pre-wrap break-all text-sm">
                {{
                  setting.secret
                    ? setting.configured
                      ? t("ui.configuredValueHidden")
                      : t("ui.notConfigured")
                    : setting.value || t("ui.notConfigured")
                }}
              </p>
              <p class="muted text-xs mt-2">
                {{
                  setting.source === "normalized"
                    ? t("ui.normalizedByEngine")
                    : setting.source === "environment"
                      ? t("ui.serverEnvironment")
                      : setting.source === "runtime"
                        ? t("ui.runtime")
                        : t("ui.default2")
                }}
              </p>
            </div>
          </div>
        </section>
        <p v-if="!pending && !filtered.length" class="empty">
          {{ query.trim() ? t("ui.noSettingsMatchYourSearch") : t("ui.noSettingsAreAvailableForThisInstance") }}
        </p>
      </div>
    </div>
  </template>
</template>
