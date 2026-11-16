<script setup lang="ts">
import type { ApplicationLog, JournalEntry, LogSnapshot } from "@trawl/client"

const desktop = useDesktopStore()
const source = shallowRef<"live" | "local">("live")
const localLog = shallowRef("")
const entries = shallowRef<JournalEntry<ApplicationLog>[]>([])
const useLive = computed(
  () => source.value === "live" && Boolean(desktop.capabilities?.logs && desktop.capabilities.logEvents),
)
const { state, error, refresh } = useInstanceFeed<ApplicationLog, LogSnapshot>({
  enabled: () => useLive.value,
  clear: () => {
    entries.value = []
    localLog.value = ""
  },
  snapshot: (api, signal) => api.logs.list(200, { signal }),
  replace: (value) => {
    entries.value = value.entries
  },
  events: (api, options) => api.logs.events(options),
  apply: (batch) => {
    entries.value = [...new Map([...entries.value, ...batch].map((entry) => [entry.id, entry])).values()].slice(-500)
  },
})
const text = computed(() =>
  entries.value.map(({ data }) => `${data.at} ${data.level.toUpperCase()} [${data.scope}] ${data.message}`).join("\n"),
)
async function loadLocal() {
  if (!desktop.native || desktop.activeId !== "local") return
  const id = desktop.activeId
  await desktop.action(async () => {
    const value = await desktop.management<string>({ action: "logs" })
    if (desktop.activeId === id) localLog.value = value
  })
}
watch(
  [() => desktop.activeId, useLive],
  ([id], previous) => {
    if (previous?.[0] !== id) source.value = "live"
    localLog.value = ""
    if (!useLive.value && desktop.activeId === "local" && desktop.native) void loadLocal()
  },
  { immediate: true },
)
</script>
<template>
  <div v-if="desktop.activeId !== 'local' && !desktop.capabilities?.logs" class="notice">
    This instance does not offer live application logs. Enable <code>OBSERVABILITY_ENABLED</code> on a compatible server
    and configure its dashboard token.
  </div>
  <template v-else>
    <div v-if="desktop.activeId === 'local' && desktop.capabilities?.logs" class="settings-toolbar">
      <USelect
        v-model="source"
        :items="[
          { label: 'Live application metadata', value: 'live' },
          { label: 'Local process log', value: 'local' },
        ]"
        aria-label="Log source"
      />
    </div>
    <div class="panel">
      <div class="panel-heading">
        <h2>{{ useLive ? "Application activity" : "Local process log" }}</h2>
        <div class="actions">
          <span v-if="useLive" class="text-xs muted" role="status">{{
            state === "live" ? "Live" : state === "paused" ? "Paused" : "Connecting…"
          }}</span>
          <UButton
            icon="i-lucide-refresh-cw"
            variant="outline"
            color="neutral"
            :loading="desktop.busy"
            :disabled="!desktop.native"
            @click="useLive ? refresh() : loadLocal()"
            >Refresh</UButton
          >
        </div>
      </div>
      <pre v-if="useLive ? text : localLog" class="log mono">{{ useLive ? text : localLog }}</pre>
      <div v-else class="empty">
        {{ useLive ? "No application activity retained yet" : "No local log entries yet" }}
      </div>
    </div>
    <p v-if="useLive" class="text-xs muted">
      Up to 500 structured application events. Includes request and server lifecycle metadata since startup; private
      diagnostics and container logs are not streamed.
    </p>
    <p v-else class="text-xs muted">
      Only the most recent 64 KiB are shown. This private local log can contain target URLs and page diagnostics.
    </p>
    <p v-if="useLive && error" class="notice error" role="alert">{{ error }}. Reconnecting automatically.</p>
  </template>
</template>
