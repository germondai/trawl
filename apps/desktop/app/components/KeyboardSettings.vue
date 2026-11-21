<script setup lang="ts">
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  defaultKeybindings,
  formatShortcut,
  type ShortcutAction,
  shortcutDefinitions,
  validateKeybindings,
} from "@trawl/config/catalog"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { eventShortcut } from "~/utils/keybindings"
import { t } from "~/utils/localization"
import { shortcutErrorMessage } from "~/utils/localized-keybindings"

const emit = defineEmits<{ dirty: [value: boolean] }>()
const desktop = useDesktopStore()
const native = isTauri()
const mac = /Mac/.test(navigator.platform)
const actions = Object.keys(shortcutDefinitions) as ShortcutAction[]
const groups = [
  {
    get label() {
      return t("ui.app")
    },
    actions: actions.filter((action) => !("scope" in shortcutDefinitions[action])),
  },
  {
    get label() {
      return t("ui.tray")
    },
    actions: actions.filter((action) => "scope" in shortcutDefinitions[action]),
  },
]
const values = () =>
  Object.fromEntries(
    actions.map((action) => [
      action,
      desktop.config.desktop.keybindings[action] ? formatShortcut(desktop.config.desktop.keybindings[action], mac) : "",
    ]),
  ) as Record<ShortcutAction, string>
const draft = ref(values())
const recording = shallowRef<ShortcutAction>()
const captureError = useErrorMessage()
const keycaps = (value: string) => (value ? value.split("+") : [])
const kbdValue = (key: string) =>
  key === "Cmd" ? "command" : key === "Ctrl" ? "ctrl" : key.length > 1 ? key.toLowerCase() : key
async function capture(action?: ShortcutAction) {
  if (native) await invoke("set_shortcut_recording", { enabled: Boolean(action) })
  recording.value = action
  captureError.value = ""
}
function recorded(value: { shortcut: string | null; cancel: boolean }) {
  const action = recording.value
  if (!action) return
  if (value.cancel) {
    void capture()
    return
  }
  if (!value.shortcut) {
    captureError.value = new LocalizedError("ui.includeAndASupportedKey", { p0: mac ? "Cmd" : "Ctrl" })
    return
  }
  draft.value[action] = formatShortcut(value.shortcut, mac)
  void capture()
}
useEventListener(
  window,
  "keydown",
  (event: KeyboardEvent) => {
    if (!recording.value) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat || ["Meta", "Control", "Alt", "Shift"].includes(event.key)) return
    recorded({
      shortcut: eventShortcut(event, mac),
      cancel: event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey,
    })
  },
  { capture: true },
)
useEventListener(window, "blur", () => {
  if (recording.value) void capture()
})
let unlisten: UnlistenFn | undefined
let disposed = false
onMounted(async () => {
  if (!native) return
  const stop = await listen<{ shortcut: string | null; cancel: boolean }>("shortcut-recorded", ({ payload }) =>
    recorded(payload),
  )
  if (disposed) stop()
  else unlisten = stop
})
const baseline = shallowRef(JSON.stringify(draft.value))
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const validation = computed(() => {
  try {
    return { bindings: validateKeybindings(draft.value), error: "" }
  } catch (error) {
    return { bindings: undefined, error: shortcutErrorMessage(error) }
  }
})
watch(
  dirty,
  (value) => {
    emit("dirty", value)
  },
  { flush: "sync" },
)
watch(
  () => desktop.config.desktop.keybindings,
  () => {
    if (!dirty.value) discard()
  },
  { deep: true },
)
onBeforeUnmount(() => {
  disposed = true
  unlisten?.()
  if (native) void invoke("set_shortcut_recording", { enabled: false })
  emit("dirty", false)
})
function discard() {
  if (recording.value) void capture()
  draft.value = values()
  baseline.value = JSON.stringify(draft.value)
}
function defaults() {
  if (recording.value) void capture()
  const values = defaultKeybindings()
  draft.value = Object.fromEntries(actions.map((action) => [action, formatShortcut(values[action], mac)])) as Record<
    ShortcutAction,
    string
  >
}
async function save() {
  if (!validation.value.bindings) return
  const config = structuredClone(toRaw(desktop.config))
  config.desktop.keybindings = validation.value.bindings
  if (await desktop.save(config)) discard()
}
</script>
<template>
  <section class="panel">
    <div class="panel-heading">
      <div>
        <h2>{{ t("ui.keyboardShortcuts") }}</h2>
        <p>
          {{ t("ui.clickAShortcutThenPressItsNewCombination") }}
        </p>
      </div>
      <UButton color="neutral" variant="ghost" :disabled="desktop.busy" @click="defaults">{{
        t("ui.restoreDefaults")
      }}</UButton>
    </div>
    <section
      v-for="group in groups"
      :key="group.label"
      class="panel-body form-stack shortcut-group"
      :aria-label="t('keyboard.groupShortcuts', { group: group.label })"
    >
      <h3>{{ group.label }}</h3>
      <UFormField
        v-for="action in group.actions"
        :key="action"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t(`shortcuts.${action}.label`)"
        :description="t('ui.default', { p0: formatShortcut(shortcutDefinitions[action].default, mac) })"
      >
        <div class="shortcut-control" :data-shortcut-recording="recording === action ? '' : undefined">
          <button
            class="shortcut-recorder"
            :class="{ recording: recording === action }"
            type="button"
            :aria-label="t('ui.changeShortcut', { p0: t(`shortcuts.${action}.label`) })"
            :aria-pressed="recording === action"
            :disabled="!desktop.native || desktop.busy"
            @click="capture(recording === action ? undefined : action)"
          >
            <span v-if="recording === action" class="text-primary">{{ t("ui.pressShortcut") }}</span>
            <template v-else-if="draft[action]"
              ><UKbd v-for="key in keycaps(draft[action])" :key="key" :value="kbdValue(key)" /></template
            >
            <span v-else class="muted">{{ t("ui.notSet") }}</span>
          </button>
          <UButton
            v-if="draft[action] || recording === action"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :aria-label="
              recording === action
                ? t('ui.cancelShortcutRecording')
                : t('ui.disableShortcut', { p0: t(`shortcuts.${action}.label`) })
            "
            :disabled="!desktop.native || desktop.busy"
            @click="recording === action ? capture() : (draft[action] = '')"
          />
        </div>
      </UFormField>
    </section>
    <div v-if="recording || validation.error" class="panel-body">
      <p v-if="recording" class="text-xs muted" role="status">
        {{ captureError || t("ui.waitingForAKeyCombinationEscCancelsWithout") }}
      </p>
      <p v-if="validation.error" class="text-error text-sm" role="alert">{{ validation.error }}</p>
    </div>
    <div class="panel-footer">
      <span class="muted text-xs">{{ t("ui.changesAlsoUpdateApplicationAndTrayMenusCtrl") }}</span>
      <div class="actions">
        <UButton color="neutral" variant="outline" :disabled="!dirty || desktop.busy" @click="discard">{{
          t("ui.discard")
        }}</UButton><UButton
          :disabled="!desktop.native || !dirty || !!validation.error || desktop.busy || !!recording"
          :loading="desktop.busy"
          @click="save"
          >{{
            t("ui.saveShortcuts")
          }}</UButton
        >
      </div>
    </div>
  </section>
</template>
<style scoped>
.shortcut-group + .shortcut-group {
  border-top: 1px solid var(--ui-border);
}
.shortcut-group > h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-muted);
}
.shortcut-control {
  display: flex;
  gap: 4px;
  align-items: center;
  width: max-content;
  max-width: 100%;
}
.shortcut-recorder {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  min-width: 84px;
  max-width: 100%;
  min-height: 36px;
  padding: 6px 8px;
  border: 1px solid var(--ui-border-accented);
  border-radius: 6px;
  text-align: left;
  font-size: 13px;
  transition:
    border-color 160ms ease,
    background-color 160ms ease;
}
.shortcut-recorder:hover {
  background: var(--ui-bg-elevated);
}
.shortcut-recorder.recording,
.shortcut-recorder:focus-visible {
  border-color: var(--ui-primary);
  outline: 2px solid color-mix(in srgb, var(--ui-primary) 15%, transparent);
}
</style>
