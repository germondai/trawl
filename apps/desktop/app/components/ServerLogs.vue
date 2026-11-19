<!-- biome-ignore-all lint/a11y/noNoninteractiveTabindex: The log viewport must support keyboard scrolling. -->
<script setup lang="ts">
import type { ApplicationLog, JournalEntry, LogSnapshot } from "@trawl/client"
import { parseProcessLog } from "~/utils/process-logs"

const desktop = useDesktopStore()
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
  { label: "All scopes", value: "all" },
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
const time = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour12: false })
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
const localError = shallowRef("")
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
    if (serial === localGeneration) localError.value = String(cause)
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
</script>
<template>
  <div v-if="desktop.activeId !== 'local' && !desktop.capabilities?.logs" class="notice">
    {{
      desktop.health
        ? "This instance does not offer application logs."
        : "This instance is unavailable. Reconnect to view application logs."
    }}
  </div>
  <section v-else class="panel logs-panel">
    <div class="panel-heading">
      <h2>Logs</h2>
      <span class="text-xs muted">{{ useLive ? "Application events" : "Local process log" }}</span>
      <div class="actions">
        <span v-if="useLive" class="status text-xs"
          ><span class="dot" :class="{ ready: state === 'live' }" />
          {{ state === "live" ? "Live" : state === "paused" ? "Paused" : "Connecting…" }}</span
        >
        <span v-else class="status text-xs"
          ><span class="dot" />{{ desktop.status.running ? "Snapshot" : "Offline" }}</span
        >
      </div>
    </div>
    <div class="log-toolbar">
      <UInput
        v-model="query"
        leading-icon="i-lucide-search"
        :ui="{ trailing: 'p-0' }"
        placeholder="Search logs"
        aria-label="Search logs"
        class="grow min-w-48"
        ><template v-if="query" #trailing
          ><UButton
            icon="i-lucide-x"
            color="neutral"
            variant="link"
            class="search-clear"
            aria-label="Clear log search"
            @click="query = ''"
          /></template
        ></UInput
      >
      <USelect
        v-if="desktop.activeId === 'local'"
        :model-value="useLive ? 'live' : 'local'"
        :items="[
          { label: 'Application events', value: 'live', disabled: !desktop.capabilities?.logs },
          { label: 'Process log', value: 'local' },
        ]"
        @update:model-value="selectSource"
        aria-label="Log source"
      />
      <USelect
        v-model="level"
        :items="[
          { label: 'All levels', value: 'all' },
          ...['error', 'warn', 'info', 'debug'].map((value) => ({ label: value, value })),
        ]"
        aria-label="Log level"
      />
      <USelect v-model="scope" :items="scopes" aria-label="Log scope" />
      <USelect
        v-model="range"
        :disabled="!useLive"
        :items="[
          { label: 'Since startup', value: 0 },
          { label: 'Last 5 minutes', value: 5 },
          { label: 'Last 15 minutes', value: 15 },
          { label: 'Last hour', value: 60 },
        ]"
        aria-label="Log time range"
      />
      <USelect
        v-model="limit"
        :items="[50, 100, 200, 500].map((value) => ({ label: `${value} entries`, value }))"
        aria-label="Log limit"
      />
      <USelect
        v-model="order"
        :items="[
          { label: 'Oldest first', value: 'oldest' },
          { label: 'Newest first', value: 'newest' },
        ]"
        aria-label="Log order"
      />
    </div>
    <section
      v-if="rows.length"
      ref="viewport"
      class="log-viewport mono"
      tabindex="0"
      aria-label="Log entries"
      @scroll.passive="onScroll"
    >
      <div v-for="row in rows" :key="row.id" class="log-line" :data-level="row.level">
        <UTooltip v-if="row.at" :text="row.at"><time :datetime="row.at">{{ time(row.at) }}</time></UTooltip>
        <span v-else class="muted" title="Timestamp unavailable">—</span>
        <span class="log-level">{{ row.level.toUpperCase() }}</span><span class="log-scope">{{ row.scope }}</span>
        <span class="log-message">{{ row.message }}</span>
      </div>
    </section>
    <div v-else class="empty">No matching log entries</div>
    <div class="panel-footer">
      <span class="text-xs muted">{{
        useLive
          ? `${rows.length} shown · Up to 500 application events retained since startup. Private diagnostics and container logs are excluded.`
          : "Latest 64 KiB of the local process log. Time filters require timestamped application events."
      }}</span>
      <UButton
        :class="{ invisible: following }"
        :aria-hidden="following"
        :tabindex="following ? -1 : undefined"
        :disabled="following"
        color="neutral"
        variant="link"
        trailing-icon="i-lucide-arrow-down"
        @click="latest(true)"
        >Latest</UButton
      >
    </div>
    <p v-if="!useLive && localError" class="notice error" role="alert">{{ localError }}</p>
    <p v-if="useLive && error" class="notice error" role="alert">{{ error }}. Reconnecting automatically.</p>
  </section>
</template>
