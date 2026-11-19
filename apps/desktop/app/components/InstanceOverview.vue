<script setup lang="ts">
import { scrollWorkspaceToTop } from "~/composables/useWorkspaceScroll"

const desktop = useDesktopStore()
const props = defineProps<{ history?: boolean; openRequestId?: string }>()
const emit = defineEmits<{ showAll: []; closeRequest: []; replay: [] }>()
const {
  entries,
  latest,
  active,
  activeTruncated,
  error: feedError,
  nextCursor,
  loadingMore,
  pageError,
  page,
  loadPage,
  query,
  queryable,
  total,
} = useRequestHistory(() => Boolean(props.history))
const scrollToTop = inject(scrollWorkspaceToTop)
async function changePage(target: number) {
  const previous = page.value
  await loadPage(target)
  if (page.value !== previous) {
    await nextTick()
    scrollToTop?.()
  }
}
const events = computed(() => {
  const recent = desktop.capabilities?.requests
    ? props.history
      ? entries.value
      : latest.value
    : (desktop.metrics?.recentEvents ?? [])
  return props.history ? recent : recent.slice(0, 5)
})
const sourceFilter = computed({
  get: () => query.value.source ?? "all",
  set: (value) => {
    query.value.source = value === "all" ? undefined : (value as NonNullable<typeof query.value.source>)
  },
})
const resultFilter = computed({
  get: () => query.value.result ?? "all",
  set: (value) => {
    query.value.result = value === "all" ? undefined : (value as "success" | "failed")
  },
})
const tierFilter = computed({
  get: () => (query.value.tier === undefined ? "all" : String(query.value.tier)),
  set: (value) => {
    query.value.tier = value === "all" ? undefined : Number(value)
  },
})
const rate = computed(() =>
  desktop.metrics?.requests ? `${Math.round((desktop.metrics.successes / desktop.metrics.requests) * 100)}%` : "n/a",
)
const maximumMs = computed(() => {
  const metrics = desktop.metrics
  if (!metrics) return undefined
  return (
    metrics.maximumMs ??
    (metrics.requests === metrics.recentEvents.length
      ? Math.max(0, ...metrics.recentEvents.map((entry) => entry.durationMs))
      : undefined)
  )
})
</script>
<template>
  <div v-if="!desktop.status.running && desktop.activeId === 'local'" class="panel empty overview-empty">
    <UIcon name="i-lucide-terminal" class="size-8 muted" />
    <h2 class="mt-4">Your local scraping engine</h2>
    <p v-if="!desktop.browser.installed">
      Install the verified browser once, then start TRAWL. This downloads roughly 300 to 700 MB and can take several
      minutes. No Docker or external runtime is required.
    </p>
    <p v-else>Start the server to accept API requests and see activity here.</p>
    <UButton
      v-if="!desktop.browser.installed"
      icon="i-lucide-download"
      :loading="desktop.busy"
      :disabled="!desktop.native"
      @click="desktop.install"
      >Install browser</UButton
    >
    <UButton v-else icon="i-lucide-play" :loading="desktop.busy" :disabled="!desktop.native" @click="desktop.start"
      >Start server</UButton
    >
  </div>
  <template v-else>
    <div v-if="!history" class="stats">
      <div class="stat">
        <div class="stat-label">Requests · last hour</div>
        <div class="stat-value mono">{{ desktop.metrics?.requests.toLocaleString() ?? "n/a" }}</div>
        <div class="stat-hint">Fresh content, reused clearance</div>
        <MetricBar
          :value="desktop.metrics?.requests"
          :max="desktop.metrics?.retainedEvents"
          :label="`${desktop.metrics?.requests ?? 0} requests in the last hour of ${desktop.metrics?.retainedEvents ?? 0} retained`"
        />
      </div>
      <div class="stat">
        <div class="stat-label">Successful requests</div>
        <div class="stat-value mono success">{{ rate }}</div>
        <div class="stat-hint">{{ desktop.metrics?.successes ?? "n/a" }} completed</div>
        <MetricBar
          :value="desktop.metrics?.successes"
          :max="desktop.metrics?.requests"
          :label="`${desktop.metrics?.successes ?? 0} successful, ${desktop.metrics?.failures ?? 0} failed`"
          failed-remainder
        />
      </div>
      <div class="stat">
        <div class="stat-label">Average response</div>
        <div class="stat-value mono">
          {{ desktop.metrics ? `${desktop.metrics.averageMs.toLocaleString()} ms` : "n/a" }}
        </div>
        <div class="stat-hint">
          {{
            maximumMs == null
              ? "Maximum not reported"
              : maximumMs
                ? `Longest request ${maximumMs.toLocaleString()} ms`
                : "No completed requests"
          }}
        </div>
        <MetricBar
          :value="desktop.metrics?.averageMs"
          :max="maximumMs"
          :label="
            maximumMs == null
              ? 'Maximum response time is unavailable'
              : `Average ${desktop.metrics?.averageMs ?? 0} ms of longest ${maximumMs} ms`
          "
        />
      </div>
    </div>
    <div v-if="desktop.metricError" class="notice">{{ desktop.metricError }}</div>
    <RequestActivity
      v-if="!history && desktop.metrics"
      :timeline="desktop.metrics.timeline"
      :bucket-ms="desktop.metrics.bucketMs"
      :range-minutes="desktop.metrics.rangeMinutes"
    />
    <BrowserCapacity v-if="!history && desktop.health" :health="desktop.health" />
    <div v-if="desktop.capabilities?.requestEvents && (active.length || activeTruncated)" class="panel">
      <div class="panel-heading">
        <h2>Running requests</h2>
        <span class="text-xs muted">{{ activeTruncated ? "Limited active list" : `${active.length} active` }}</span>
      </div>
      <div v-for="request in active" :key="request.id" class="connection">
        <div>
          <strong>{{ request.domain }}</strong>
          <p class="text-xs muted">
            {{ request.method }} · {{ request.source }} · Started {{ new Date(request.startedAt).toLocaleTimeString() }}
          </p>
        </div>
        <span class="text-xs muted" role="status">Running</span>
      </div>
      <p v-if="activeTruncated" class="panel-body text-xs muted">
        The active-request list reached its display limit. Additional activity may be omitted.
      </p>
    </div>
    <p v-if="feedError" class="notice error" role="alert">{{ feedError }}. Reconnecting automatically.</p>
    <div v-if="history && queryable" class="history-toolbar">
      <UInput
        v-model="query.search"
        leading-icon="i-lucide-search"
        :ui="{ trailing: 'p-0' }"
        placeholder="Search domain, source, cause or ID"
        aria-label="Search requests"
        :maxlength="200"
        class="grow min-w-48"
        ><template v-if="query.search" #trailing
          ><UButton
            icon="i-lucide-x"
            color="neutral"
            variant="link"
            class="search-clear"
            aria-label="Clear request search"
            @click="query.search = undefined"
          /></template
        ></UInput
      >
      <USelect
        v-model="sourceFilter"
        :items="[
          { label: 'All sources', value: 'all' },
          ...['native', 'flaresolverr', 'mcp', 'proxy'].map((value) => ({ label: value, value })),
        ]"
        aria-label="Request source"
      />
      <USelect
        v-model="resultFilter"
        :items="[
          { label: 'All results', value: 'all' },
          { label: 'Success', value: 'success' },
          { label: 'Failed', value: 'failed' },
        ]"
        aria-label="Request result"
      />
      <USelect
        v-model="tierFilter"
        :items="[
          { label: 'All tiers', value: 'all' },
          ...[0, 1, 2, 3, 4].map((value) => ({ label: `Tier ${value}`, value: String(value) })),
        ]"
        aria-label="Request tier"
      />
      <USelect
        v-model="query.sort"
        :items="[
          { label: 'Newest first', value: 'newest' },
          { label: 'Oldest first', value: 'oldest' },
          { label: 'Slowest first', value: 'slowest' },
          { label: 'Fastest first', value: 'fastest' },
        ]"
        aria-label="Request sort"
      />
    </div>
    <div class="request-results">
      <RequestHistory
        :events="events"
        :instance-id="desktop.activeId"
        :show-date="history"
        :open-request-id="openRequestId"
        :active-requests="active"
        @close-request="emit('closeRequest')"
        @replay="emit('replay')"
      >
        <template v-if="!history" #actions>
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            class="p-0 font-normal"
            trailing-icon="i-lucide-chevron-right"
            aria-label="Show all requests"
            @click="emit('showAll')"
            >Show all</UButton
          >
        </template>
      </RequestHistory>
      <div v-if="history && desktop.capabilities?.requests" class="flex justify-center">
        <UPagination
          :page="page"
          :items-per-page="20"
          :total="total ?? (page + (nextCursor ? 1 : 0)) * 20"
          :disabled="loadingMore"
          :sibling-count="1"
          :ui="{ first: 'hidden', last: 'hidden' }"
          @update:page="changePage"
        />
      </div>
    </div>
    <p v-if="pageError" class="notice error" role="alert">{{ pageError }}</p>
  </template>
</template>
<style scoped>
.request-results {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.request-results > :deep(.panel) {
  margin-bottom: 0;
}
</style>
