<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core"
import { type Connection, orderedInstanceIds, type UserConfig } from "@trawl/config/catalog"
import { type AppLanguage, appLocales, isAppLanguage, localeNames } from "@trawl/config/i18n"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"
import { t } from "~/utils/localization"

const emit = defineEmits<{ onboarding: [] }>()
const props = defineProps<{ focusConnections?: number }>()
const connectionSection = useTemplateRef<HTMLElement>("connectionSection")
const highlightConnections = shallowRef(false)
watch(
  () => props.focusConnections,
  async (revision, _, cleanup) => {
    if (!revision) return
    let timer: ReturnType<typeof setTimeout> | undefined
    cleanup(() => clearTimeout(timer))
    await nextTick()
    connectionSection.value?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      block: "center",
    })
    highlightConnections.value = true
    timer = setTimeout(() => {
      highlightConnections.value = false
    }, 2500)
  },
  { immediate: true, flush: "post" },
)
const desktop = useDesktopStore()
const languages = computed(() => [
  ...appLocales.map((value) => ({
    value,
    label: localeNames[value],
    icon: undefined,
    avatar: { src: `/flags/${value}.svg`, alt: "" },
  })),
  { value: "system" as AppLanguage, label: t("language.system"), icon: "i-lucide-globe", avatar: undefined },
])
const selectedLanguage = computed(() =>
  languages.value.find((item) => item.value === (desktop.config.desktop.language ?? "system")),
)
async function changeLanguage(value: unknown) {
  if (!isAppLanguage(value)) return
  const config = structuredClone(toRaw(desktop.config))
  config.desktop.language = value
  await desktop.save(config)
}
const privateConnection = shallowRef(false)
useNavigationModal(privateConnection, false)
const { copy: copyPrivateCommand, copied: privateCommandCopied } = useClipboard()
const { phone } = useAppLayout()
const liveActivityKey = shallowRef<string>()
const liveActivityError = useErrorMessage()
const liveActivity = computed(() => (liveActivityKey.value ? t(liveActivityKey.value) : liveActivityError.value))
async function checkLiveActivity() {
  try {
    const support = await invoke<{ androidLiveUpdates: boolean; xiaomi: boolean; focusAllowed: boolean }>(
      "live_activity_status",
    )
    liveActivityError.value = undefined
    liveActivityKey.value = support.focusAllowed
      ? "ui.xiaomiHyperislandIsAvailableAndAccessIsEnabled"
      : support.xiaomi
        ? "ui.xiaomiHasNotEnabledHyperislandAccessForThis"
        : support.androidLiveUpdates
          ? "ui.androidLiveUpdatesAreSupportedTheSystemDecides"
          : "ui.thisAndroidVersionUsesTheStandardOngoingServer"
  } catch (cause) {
    liveActivityKey.value = undefined
    liveActivityError.value = cause
  }
}
function connectionActions(connection: Connection, index: number) {
  const unavailable = !desktop.native || desktop.busy || desktop.settingsDirty
  return [
    {
      label: t("ui.connect"),
      icon: "i-lucide-server",
      disabled: unavailable || desktop.activeId === connection.id,
      onSelect: () => desktop.select(connection.id),
    },
    {
      label: t("ui.moveUp"),
      icon: "i-lucide-chevron-up",
      disabled: unavailable || index === 0,
      onSelect: () => reorder(connection.id, -1),
    },
    {
      label: t("ui.moveDown"),
      icon: "i-lucide-chevron-down",
      disabled: unavailable || index === desktop.instances.length - 1,
      onSelect: () => reorder(connection.id, 1),
    },
    {
      label: t("ui.editConnection"),
      icon: "i-lucide-pencil",
      disabled: unavailable,
      onSelect: () => {
        editing.value = connection
      },
    },
    {
      label: t("ui.removeConnection"),
      icon: "i-lucide-trash-2",
      disabled: unavailable || connection.id === "local",
      onSelect: () => {
        removing.value = connection
      },
    },
  ]
}
const instanceURLPlaceholder = "https://trawl.example.com"
const macOS = /Mac/.test(navigator.platform)
const name = shallowRef("")
const baseURL = shallowRef("")
const apiKey = shallowRef("")
const editing = shallowRef<Connection>()
const editDirty = shallowRef(false)
const removing = shallowRef<Connection>()
const shortcutDirty = shallowRef(false)
const dirty = computed(() => Boolean(name.value || baseURL.value || apiKey.value))
watch(
  [dirty, shortcutDirty, editDirty],
  ([connection, shortcuts, modal]) => {
    desktop.settingsDirty = connection || shortcuts || modal
  },
  { flush: "sync" },
)
onBeforeUnmount(() => {
  desktop.settingsDirty = false
})
useNavigationModal(removing, undefined)
useNavigationModal(editing, undefined)
const canSave = computed(
  () => desktop.native && !desktop.busy && Boolean(name.value.trim()) && Boolean(baseURL.value.trim()),
)
async function openAddress(event: MouseEvent, url: string) {
  if (!desktop.native) return
  event.preventDefault()
  try {
    await invoke("open_connection_url", { url })
  } catch (cause) {
    desktop.setError(cause)
  }
}
async function androidSettings() {
  try {
    await invoke("reveal_storage")
  } catch (cause) {
    desktop.setError(cause)
  }
}
function cancel() {
  name.value = ""
  baseURL.value = ""
  apiKey.value = ""
}
async function saveConnection() {
  if (!canSave.value) return
  const config = structuredClone(toRaw(desktop.config))
  const connection = {
    id: crypto.randomUUID(),
    name: name.value.trim(),
    baseURL: baseURL.value.trim(),
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
  }
  config.desktop.instanceOrder = [...orderedInstanceIds(config.desktop), connection.id]
  config.desktop.connections.push(connection)
  if (await desktop.save(config)) cancel()
}
async function reorder(id: string, direction: -1 | 1) {
  if (!(await desktop.reorderInstance(id, direction)))
    useToast().add({ title: t("ui.couldNotChangeConnectionOrder"), description: desktop.error, color: "error" })
}
async function remove() {
  const id = removing.value?.id
  if (!id || id === "local") return
  const config = structuredClone(toRaw(desktop.config))
  config.desktop.instanceOrder = orderedInstanceIds(config.desktop).filter((value) => value !== id)
  config.desktop.connections = config.desktop.connections.filter((connection) => connection.id !== id)
  if (!(await desktop.save(config))) return
  removing.value = undefined
  if (desktop.activeId === id) await desktop.select("local")
}
async function preference(
  key:
    | "closeBehavior"
    | "quitBehavior"
    | "appVisibility"
    | "autostart"
    | "startServerOnLaunch"
    | "smoothScroll"
    | "liveActivities"
    | "sidebarBehavior",
  value: unknown,
) {
  const config = structuredClone(toRaw(desktop.config))
  if (key === "closeBehavior") config.desktop.closeBehavior = value as UserConfig["desktop"]["closeBehavior"]
  else if (key === "quitBehavior") config.desktop.quitBehavior = value as UserConfig["desktop"]["quitBehavior"]
  else if (key === "appVisibility") config.desktop.appVisibility = value as UserConfig["desktop"]["appVisibility"]
  else if (key === "sidebarBehavior") config.desktop.sidebarBehavior = value as UserConfig["desktop"]["sidebarBehavior"]
  else config.desktop[key] = Boolean(value)
  await desktop.save(config)
}
</script>
<template>
  <div class="panel">
    <div class="panel-heading" data-tour="preferences">
      <h2>{{ t("ui.applicationBehavior") }}</h2>
      <AppTooltip :text="t('onboarding.open')"
        ><UButton
          icon="i-lucide-info"
          color="neutral"
          variant="ghost"
          :aria-label="t('onboarding.open')"
          @click="emit('onboarding')"
          ><span class="hidden sm:inline">{{ t("onboarding.open") }}</span></UButton
        ></AppTooltip
      >
    </div>
    <div class="panel-body form-stack">
      <UFormField
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('language.label')"
        :description="t('language.description')"
      >
        <USelect
          :model-value="desktop.config.desktop.language ?? 'system'"
          :items="languages"
          :icon="selectedLanguage?.icon"
          :avatar="selectedLanguage?.avatar"
          :ui="{ itemLeadingAvatar: 'h-3.5 w-5 rounded-xs' }"
          class="preference-select"
          :disabled="!desktop.native || !desktop.loaded || desktop.busy"
          @update:model-value="changeLanguage"
        />
      </UFormField>
      <UFormField
        v-if="desktop.mobile"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.backgroundServer')"
        :description="t('ui.theForegroundServiceRunsTheServerInA')"
      >
        <UButton icon="i-lucide-power" color="neutral" variant="outline" @click="androidSettings">{{
          t("ui.openAndroidSettings")
        }}</UButton>
      </UFormField>
      <UFormField
        v-if="!desktop.mobile"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.whenTheWindowCloses')"
        :description="t('ui.closeTheWindowAndKeepTrawlAvailableOr')"
        ><USelect
          :model-value="desktop.config.desktop.closeBehavior"
          :items="[
            { label: t('ui.askMe'), value: 'ask' },
            { label: t('ui.keepRunningInBackground'), value: 'tray' },
            { label: t('ui.quitAndStopMyServer'), value: 'quit' },
          ]"
          :disabled="!desktop.native || desktop.busy"
          class="preference-select"
          @update:model-value="preference('closeBehavior', $event)"
        /></UFormField
      >
      <UFormField
        v-if="!desktop.mobile && macOS"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.quitShortcutBehavior')"
        :description="t('ui.quitTrawlAndStopItsLocalServerMenu')"
      >
        <USelect
          :model-value="desktop.config.desktop.quitBehavior"
          :items="[
            { label: t('ui.quitImmediately'), value: 'immediate' },
            { label: t('ui.pressTwice'), value: 'double-press' },
            { label: t('ui.holdForOneSecond'), value: 'hold' },
          ]"
          class="preference-select"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('quitBehavior', $event)"
        />
      </UFormField>
      <UFormField
        v-if="!desktop.mobile && macOS"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.showTrawlIn')"
        :description="t('ui.chooseWhereTrawlStaysAccessibleAfterClosingIts')"
      >
        <USelect
          :model-value="desktop.config.desktop.appVisibility"
          :items="[
            { label: t('ui.dockAndMenuBar'), value: 'dock-and-tray' },
            { label: t('ui.dock'), value: 'dock' },
            { label: t('ui.menuBar'), value: 'tray' },
          ]"
          class="preference-select"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('appVisibility', $event)"
        />
      </UFormField>
      <UFormField
        v-if="!phone"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.sidebarToggle')"
        :description="t('ui.chooseWhatTheSidebarButtonDoesWhenClosing')"
      >
        <USelect
          class="preference-select"
          :model-value="desktop.config.desktop.sidebarBehavior ?? 'collapse'"
          :items="[
            { label: t('ui.collapseToIcons'), value: 'collapse' },
            { label: t('ui.hideCompletely'), value: 'hide' },
          ]"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('sidebarBehavior', $event)"
        />
      </UFormField>
      <UFormField
        v-if="!desktop.mobile"
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.startTrawlWhenISignIn')"
        ><USwitch
          :aria-label="t('ui.startTrawlWhenISignIn')"
          :model-value="desktop.config.desktop.autostart"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('autostart', $event)"
        /><template #description>{{ t("ui.startsTheDesktopApplicationInTheBackgroundYou") }}</template></UFormField
      ><UFormField
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.startTheLocalServerWithTheApplication')"
      >
        <USwitch
          :aria-label="t('ui.startTheLocalServerWithTheApplication')"
          :model-value="desktop.config.desktop.startServerOnLaunch"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('startServerOnLaunch', $event)"
        />
        <template #description>{{ t("ui.requiresTheBrowserToBeInstalledTheServer") }}</template>
      </UFormField>
      <UFormField
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.smoothWheelScrolling')"
        :description="t('ui.useLenisForSmoothWheelScrollingThroughoutThe')"
        ><USwitch
          :aria-label="t('ui.smoothWheelScrolling')"
          :model-value="desktop.config.desktop.smoothScroll"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('smoothScroll', $event)"
        /></UFormField
      >
    </div>
  </div>
  <div v-if="desktop.mobile" class="panel">
    <div class="panel-heading">
      <h2>{{ t("ui.notifications") }}</h2>
      <AppTooltip :text="t('ui.checkLiveActivitySupport')">
        <UButton
          icon="i-lucide-info"
          color="neutral"
          variant="ghost"
          :aria-label="t('ui.checkLiveActivitySupport')"
          :disabled="!desktop.native || desktop.busy"
          @click="checkLiveActivity"
        />
      </AppTooltip>
    </div>
    <div class="panel-body form-stack">
      <UFormField
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.liveActivities')"
        :description="
          desktop.config.desktop.liveActivities !== false
            ? t('ui.showAndroidLiveUpdatesOrXiaomiHyperislandThese')
            : t('ui.useACollapsibleServerNotificationExpandItTo')
        "
      >
        <USwitch
          :aria-label="t('ui.liveActivities')"
          :model-value="desktop.config.desktop.liveActivities !== false"
          :disabled="!desktop.native || desktop.busy"
          @update:model-value="preference('liveActivities', $event)"
        />
      </UFormField>
      <p v-if="liveActivity" class="text-sm muted" role="status">{{ liveActivity }}</p>
    </div>
  </div>
  <KeyboardSettings v-if="!desktop.mobile" @dirty="shortcutDirty = $event" />
  <ApplicationUpdates />
  <div class="panel">
    <div class="panel-heading" data-tour="instance"><h2>{{ t("ui.savedConnections") }}</h2></div>
    <div v-for="(connection, index) in desktop.instances" :key="connection.id" class="connection">
      <div>
        <div class="flex items-center gap-2">
          <strong>{{ connection.name }}</strong>
          <AppTooltip v-if="connection.id === 'local'" :text="t('ui.managedOnThisDevice')"
            ><UIcon
              name="i-lucide-monitor"
              class="size-4 text-primary"
              role="img"
              :aria-label="t('ui.localInstance')"
            /></AppTooltip
          >
        </div>
        <p class="mono text-xs">
          <a
            :href="connection.baseURL"
            @click="openAddress($event, connection.baseURL)"
            target="_blank"
            rel="noopener noreferrer"
            class="connection-address"
            >{{
              connection.baseURL
            }}</a
          >
        </p>
      </div>
      <div class="actions">
        <template v-if="phone">
          <UBadge v-if="desktop.activeId === connection.id" color="neutral" variant="subtle">{{
            t("ui.selected")
          }}</UBadge>
          <UDropdownMenu :items="connectionActions(connection, index)">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-ellipsis"
              :aria-label="t('ui.manage2', { p0: connection.name })"
            />
          </UDropdownMenu>
        </template>
        <template v-else>
          <UButton
            color="neutral"
            variant="outline"
            :disabled="!desktop.native || desktop.busy || desktop.settingsDirty || desktop.activeId === connection.id"
            @click="desktop.select(connection.id)"
            >{{
              desktop.activeId === connection.id ? t("ui.selected") : t("ui.connect")
            }}</UButton
          >
          <AppTooltip :text="t('ui.moveUp')"
            ><span
              ><UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-chevron-up"
                :aria-label="t('ui.moveUp2', { p0: connection.name })"
                :disabled="index === 0 || !desktop.native || desktop.busy || desktop.settingsDirty"
                @click="reorder(connection.id, -1)"
              /></span
            ></AppTooltip
          >
          <AppTooltip :text="t('ui.moveDown')"
            ><span
              ><UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-chevron-down"
                :aria-label="t('ui.moveDown2', { p0: connection.name })"
                :disabled="
                  index === desktop.instances.length - 1 || !desktop.native || desktop.busy || desktop.settingsDirty
                "
                @click="reorder(connection.id, 1)"
              /></span
            ></AppTooltip
          >
          <AppTooltip :text="t('ui.editConnection')">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-pencil"
              :aria-label="t('ui.edit', { p0: connection.name })"
              :disabled="!desktop.native || desktop.busy || dirty"
              @click="editing = connection"
            />
          </AppTooltip>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-trash-2"
            :aria-label="t('ui.remove', { p0: connection.name })"
            :disabled="connection.id === 'local' || !desktop.native || desktop.busy || desktop.settingsDirty"
            @click="removing = connection"
          />
        </template>
      </div>
    </div>
  </div>
  <div ref="connectionSection" class="panel" :data-target="highlightConnections">
    <div class="panel-heading connection-add-heading">
      <h2>{{ t("ui.addAnExistingInstance") }}</h2>
      <AppTooltip :text="t('ui.connectPrivately')"
        ><UButton
          icon="i-lucide-network"
          color="neutral"
          variant="ghost"
          :aria-label="t('ui.connectPrivately')"
          :label="phone ? undefined : t('ui.connectPrivately')"
          @click="privateConnection = true"
        /></AppTooltip
      >
    </div>
    <form class="panel-body form-stack" @submit.prevent="saveConnection">
      <p>
        {{ t("ui.viewAnExistingServerThroughItsNativeApi") }}
      </p>
      <UFormField :label="t('ui.name')" required
        ><UInput
          v-model="name"
          :placeholder="t('ui.homeServer')"
          :maxlength="100"
          required
          :disabled="!desktop.native || desktop.busy"
        /></UFormField
      ><UFormField :label="t('ui.apiUrl')"
        ><UInput
          v-model="baseURL"
          :placeholder="instanceURLPlaceholder"
          type="url"
          required
          :disabled="!desktop.native || desktop.busy"
        /></UFormField
      ><UFormField :label="t('ui.apiDashboardToken')"
        ><UInput
          v-model="apiKey"
          type="password"
          autocomplete="off"
          :placeholder="t('ui.optional')"
          :disabled="!desktop.native || desktop.busy"
        /></UFormField
      >
      <div class="actions">
        <UButton type="submit" :disabled="!canSave">{{ t("ui.saveConnection") }}</UButton>
        <UButton v-if="dirty" color="neutral" variant="ghost" :disabled="desktop.busy" @click="cancel">{{
          t("ui.cancel")
        }}</UButton>
      </div>
    </form>
  </div>
  <ConnectionEditor v-model="editing" @dirty="editDirty = $event" />
  <AppDialog
    v-model:open="privateConnection"
    :title="t('ui.connectPrivately')"
    :description="t('ui.useAPrivateTailscaleConnectionBetweenTheTrawl')"
  >
    <template #body>
      <ol class="space-y-4 list-decimal ps-5 text-sm">
        <li>
          {{ t("ui.installTailscaleOnTheHostAndThisDevice") }}
        </li>
        <li>
          <LocalizedMessage message="private.hostCommand">
            <template #address><code>127.0.0.1</code></template>
            <template #command><code class="selectable">tailscale serve --bg 8191</code></template>
          </LocalizedMessage>
        </li>
        <li>
          {{ t("ui.copyThePrivateHttpsAddressShownByTailscale") }}
        </li>
      </ol>
    </template>
    <template #footer
      ><UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-copy"
        @click="copyPrivateCommand('tailscale serve --bg 8191')"
        >{{
          privateCommandCopied ? t("ui.copied") : t("ui.copyHostCommand")
        }}</UButton
      ><UButton @click="privateConnection = false">{{ t("ui.done") }}</UButton></template
    >
  </AppDialog>
  <AppDialog
    :open="Boolean(removing)"
    :content="confirmationContent"
    :title="t('ui.removeSavedConnection')"
    :description="t('ui.removeFromTrawlItsServerAndDataAre', { p0: removing?.name ?? t('ui.thisConnection') })"
    @update:open="!$event && (removing = undefined)"
  >
    <template #body><p v-if="desktop.error" class="notice error" role="alert">{{ desktop.error }}</p></template>
    <template #footer
      ><UButton color="neutral" variant="ghost" :disabled="desktop.busy" @click="removing = undefined">{{
        t("ui.cancel")
      }}</UButton><UButton color="error" :disabled="desktop.busy" data-confirm-default @click="remove">{{
        t("ui.removeConnection")
      }}</UButton></template
    >
  </AppDialog>
</template>

<style scoped>
.connection-address {
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 3px;
}
.connection-address:hover,
.connection-address:focus-visible {
  color: var(--ui-primary);
  text-decoration-color: currentColor;
}
</style>
