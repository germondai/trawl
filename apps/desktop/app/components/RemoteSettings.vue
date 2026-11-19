<script setup lang="ts">
import type { InstanceSetting } from "@trawl/client"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import type { SettingTarget } from "~/utils/setting-navigation"
import { sectionFor, settingLabel, settingSections } from "~/utils/settings"

const props = defineProps<{ focusSetting?: SettingTarget }>()

const emit = defineEmits<{ focused: [] }>()
const desktop = useDesktopStore()
const query = shallowRef("")
const selected = shallowRef<(typeof settingSections)[number]["id"]>("general")
useNavigationSelection("settings-category", selected)
const values = shallowRef<InstanceSetting[]>([])
const { highlighted } = useSettingFocus(
  () => props.focusSetting,
  () => values.value,
  query,
  selected,
  () => emit("focused"),
)
const error = shallowRef("")
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
        error.value = cause instanceof Error ? cause.message : "Cannot read instance settings"
    } finally {
      finish(refreshCount)
      if (!controller.signal.aborted) pending.value = false
    }
  },
  { immediate: true },
)
const sections = computed(() =>
  settingSections.map((section) => ({
    ...section,
    settings: values.value.filter((setting) => sectionFor(setting) === section.id),
  })),
)
const filtered = computed(() =>
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
const groupItems = computed(() => sections.value.map(({ id, label }) => ({ label, value: id })))
</script>
<template>
  <div v-if="!desktop.health" class="notice">This instance is unavailable. Reconnect to inspect its settings.</div>
  <div v-else-if="!desktop.capabilities?.settings" class="notice">
    This instance does not offer settings inspection. It requires a compatible server with
    <SettingLink name="OBSERVABILITY_ENABLED">OBSERVABILITY_ENABLED=true</SettingLink>
    and a configured dashboard token.
  </div>
  <template v-else>
    <div class="settings-toolbar">
      <UInput
        v-model="query"
        leading-icon="i-lucide-search"
        :ui="{ trailing: 'p-0' }"
        placeholder="Search settings"
        aria-label="Search remote settings"
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
      >
      <span class="settings-count"
        >{{
          query.trim()
            ? `${filtered.reduce((sum, section) => sum + section.settings.length, 0)} matches`
            : `${values.length} settings`
        }}
        · Read only</span
      >
    </div>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-else-if="pending && !values.length" class="muted" role="status">Reading instance settings…</p>
    <div v-else class="settings-layout">
      <nav class="settings-nav" aria-label="Remote setting categories">
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
          aria-label="Remote setting category"
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
              <p class="setting-description"><SettingText :text="setting.description" /></p>
              <code class="setting-name mono">{{ setting.name }}</code>
            </div>
            <div class="setting-control min-w-0">
              <p class="mono whitespace-pre-wrap break-all text-sm">
                {{
                  setting.secret
                    ? setting.configured
                      ? "Configured · value hidden"
                      : "Not configured"
                    : setting.value || "Not configured"
                }}
              </p>
              <p class="muted text-xs mt-2">
                {{
                  setting.source === "normalized"
                    ? "Normalized by engine"
                    : setting.source === "environment"
                      ? "Server environment"
                      : setting.source === "runtime"
                        ? "Runtime"
                        : "Default"
                }}
              </p>
            </div>
          </div>
        </section>
        <p v-if="!filtered.length" class="empty">No settings match your search</p>
      </div>
    </div>
  </template>
</template>
