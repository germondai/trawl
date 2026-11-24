<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex: The log viewport must support keyboard scrolling. -->
<script setup lang="ts">
import type { ApplicationLog, JournalEntry, LogSnapshot } from "@trawl/client"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { formatLocale, t } from "~/utils/localization"
import { parseProcessLog } from "~/utils/process-logs"

const desktop = useDesktopStore()
const { phone } = useAppLayout()
const source = shallowRef<"live" | "local">("live")
function selectSource(value: string) {
  if (value === "live" || value === "local") source.value = value
}
const localLog = shallowRef("")
const entries = shallowRef<JournalEntry<ApplicationLog>[]>([])
const useLive = computed(() => source.value === "live" && Boolean(desktop.capabilities?.logs))
const query = shallowRef("")
const level = shallowRef("all")
const scope = shallowRef("all")
const limit = shallowRef(200)
const range = shallowRef(0)
const order = shallowRef("oldest")
const viewport = useTemplateRef<HTMLElement>("viewport")
const following = shallowRef(true)
const now = useNow({ interval: 10000 })
const { state, error, refresh } = useInstanceFeed<ApplicationLog, LogSnapshot>({
  enabled: () => useLive.value,
  polling: () => !desktop.capabilities?.logEvents,
  clear: () => {
    entries.value = []
    localLog.value = ""
  },
  snapshot: (api, signal) => api.logs.list(500, { signal }),
  replace: (value) => {
    entries.value = value.entries
  },
  events: (api, options) => api.logs.events(options),
  apply: (batch) => {
    entries.value = [...new Map([...entries.value, ...batch].map((entry) => [entry.id, entry])).values()].slice(-500)
  },
})
usePageRefresh(() => (useLive.value ? refresh() : loadLocal()))
const values = computed(() =>
  useLive.value
    ? entries.value.map(({ id, data }) => ({ id, ...data }))
    : localLog.value
        .split("\n")
        .filter(Boolean)
        .map((message, index) => ({ id: `local-${index}`, ...parseProcessLog(message) })),
)
const scopes = computed(() => [
  { label: t("ui.allScopes"), value: "all" },
  ...[...new Set(values.value.map((row) => row.scope))].sort().map((value) => ({ label: value, value })),
])
const rows = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const selected = values.value
    .filter(
      (row) =>
        (level.value === "all" || row.level === level.value) &&
        (scope.value === "all" || row.scope === scope.value) &&
        (!useLive.value || !range.value || Date.parse(row.at) >= now.value.getTime() - range.value * 60000) &&
        (!needle || `${row.at} ${row.level} ${row.scope} ${row.message}`.toLowerCase().includes(needle)),
    )
    .slice(-limit.value)
  return order.value === "newest" ? selected.reverse() : selected
})
const time = (value: string) => new Date(value).toLocaleTimeString(formatLocale(), { hour12: false })
function onScroll() {
  const element = viewport.value
  if (element)
    following.value =
      order.value === "newest"
        ? element.scrollTop <= 24
        : element.scrollHeight - element.clientHeight - element.scrollTop <= 24
}
async function latest(smooth = false) {
  following.value = true
  await nextTick()
  viewport.value?.scrollTo({
    top: order.value === "newest" ? 0 : viewport.value.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  })
}
watch(
  rows,
  async () => {
    if (following.value) await latest()
  },
  { flush: "post" },
)
watch([query, level, scope, limit, range, order, source, useLive], () => {
  void latest()
})
const localError = useErrorMessage()
let localGeneration = 0
onScopeDispose(() => {
  localGeneration++
})
async function loadLocal() {
  if (!desktop.native || desktop.activeId !== "local") return
  const serial = ++localGeneration
  const id = desktop.activeId
  try {
    const value = await desktop.management<string>({ action: "logs" })
    if (serial === localGeneration && desktop.activeId === id && !useLive.value) {
      localLog.value = value
      localError.value = ""
    }
  } catch (cause) {
    if (serial === localGeneration) localError.value = cause
  }
}
watch(
  [() => desktop.activeId, useLive],
  ([id], previous) => {
    if (previous?.[0] !== id) {
      source.value = "live"
      following.value = true
      scope.value = "all"
    }
    if (previous?.[0] !== id) localLog.value = ""
    localGeneration++
    if (!useLive.value && desktop.activeId === "local" && desktop.native) void loadLocal()
  },
  { immediate: true },
)
const { resume: followStartup, pause: stopFollowingStartup } = useTimeoutPoll(loadLocal, 2000, {
  immediate: false,
})
watch(
  () => !useLive.value && desktop.activeId === "local" && desktop.starting,
  (starting) => {
    if (starting) followStartup()
    else stopFollowingStartup()
  },
  { immediate: true },
)
</script>
<template>
  <div v-if="desktop.activeId !== 'local' && !desktop.capabilities?.logs" class="notice">
    {{
      desktop.health
        ? t("ui.thisInstanceDoesNotOfferApplicationLogs")
        : t("ui.thisInstanceIsUnavailableReconnectToViewApplication")
    }}
  </div>
  <section v-else class="panel logs-panel">
    <p
      v-if="
        desktop.activeId === 'local' && (desktop.starting || (desktop.status.running && desktop.status.ready === false))
      "
      class="notice"
      role="status"
    >
      {{ t("ui.startingLocalServerAndPreparingTheBrowser") }}
    </p>
    <div class="panel-heading">
      <h2>{{ t("ui.logs") }}</h2>
      <span class="text-xs muted">{{ useLive ? t("ui.applicationEvents") : t("ui.localProcessLog") }}</span>
      <div class="actions">
        <span v-if="useLive" class="status text-xs"
          ><span class="dot" :class="{ ready: state === 'live' }" />
          {{ state === "live" ? t("ui.live") : state === "paused" ? t("ui.paused") : t("ui.connecting") }}</span
        >
        <span v-else class="status text-xs"
          ><span class="dot" />{{ desktop.status.running ? t("ui.snapshot") : t("ui.offline") }}</span
        >
      </div>
    </div>
    <div class="log-toolbar">
      <UInput
        v-model="query"
        leading-icon="i-lucide-search"
        :ui="{ trailing: 'p-0' }"
        :placeholder="t('ui.searchLogs')"
        :aria-label="t('ui.searchLogs')"
        data-type-focus
        class="grow min-w-48"
        ><template v-if="query" #trailing
          ><UButton
            icon="i-lucide-x"
            color="neutral"
            variant="link"
            class="search-clear"
            :aria-label="t('ui.clearLogSearch')"
            @click="query = ''"
          /></template
        ></UInput
      >
      <USelect
        v-if="desktop.activeId === 'local'"
        :model-value="useLive ? 'live' : 'local'"
        :items="[
          { label: t('ui.applicationEvents'), value: 'live', disabled: !desktop.capabilities?.logs },
          { label: t('ui.processLog'), value: 'local' },
        ]"
        @update:model-value="selectSource"
        :aria-label="t('ui.logSource')"
      />
      <USelect
        v-model="level"
        :items="[
          { label: t('ui.allLevels'), value: 'all' },
          ...['error', 'warn', 'info', 'debug'].map((value) => ({ label: t(`logs.level.${value}`), value })),
        ]"
        :aria-label="t('ui.logLevel')"
      />
      <USelect v-model="scope" :items="scopes" :aria-label="t('ui.logScope')" />
      <USelect
        v-model="range"
        :disabled="!useLive"
        :items="[
          { label: t('ui.sinceStartup'), value: 0 },
          { label: t('ui.last5Minutes'), value: 5 },
          { label: t('ui.last15Minutes'), value: 15 },
          { label: t('ui.lastHour'), value: 60 },
        ]"
        :aria-label="t('ui.logTimeRange')"
      />
      <USelect
        v-model="limit"
        :items="[50, 100, 200, 500].map((value) => ({ label: t('counts.entries', { count: value }), value }))"
        :aria-label="t('ui.logLimit')"
      />
      <USelect
        v-model="order"
        :items="[
          { label: t('ui.oldestFirst'), value: 'oldest' },
          { label: t('ui.newestFirst'), value: 'newest' },
        ]"
        :aria-label="t('ui.logOrder')"
      />
    </div>
    <section
      v-if="rows.length"
      ref="viewport"
      class="log-viewport mono"
      tabindex="0"
      :aria-label="t('ui.logEntries')"
      @scroll.passive="onScroll"
    >
      <div v-for="row in rows" :key="row.id" class="log-line" :data-level="row.level">
        <AppTooltip v-if="row.at" :text="row.at"><time :datetime="row.at">{{ time(row.at) }}</time></AppTooltip>
        <span v-else class="muted" :title="t('ui.timestampUnavailable')">—</span>
        <span class="log-level">{{ row.level.toUpperCase() }}</span><span class="log-scope">{{ row.scope }}</span>
        <span class="log-message">{{ row.message }}</span>
      </div>
    </section>
    <div v-else class="empty">{{ t("ui.noMatchingLogEntries") }}</div>
    <div class="panel-footer">
      <span class="text-xs muted">{{
        useLive ? t("logs.retention", { count: rows.length }) : t("ui.latest64KibOfTheLocalProcessLog")
      }}</span>
      <UButton
        v-if="!following || !phone"
        class="shrink-0 whitespace-nowrap"
        :class="{ invisible: following }"
        :aria-hidden="following"
        :tabindex="following ? -1 : undefined"
        :disabled="following"
        color="neutral"
        variant="link"
        trailing-icon="i-lucide-arrow-down"
        @click="latest(true)"
        >{{
          t("ui.latest")
        }}</UButton
      >
    </div>
    <p v-if="!useLive && localError" class="notice error" role="alert">{{ localError }}</p>
    <p v-if="useLive && error" class="notice error" role="alert">{{ t("errors.reconnecting", { error }) }}</p>
  </section>
</template>
