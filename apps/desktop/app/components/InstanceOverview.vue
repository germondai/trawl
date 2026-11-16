<script setup lang="ts">
const desktop = useDesktopStore()
const props = defineProps<{ history?: boolean; openRequestId?: string }>()
const emit = defineEmits<{ showAll: []; closeRequest: [] }>()
const {
  entries,
  active,
  activeTruncated,
  state,
  error: feedError,
  nextCursor,
  loadingMore,
  pageError,
  loadMore,
} = useRequestHistory()
const events = computed(() => {
  const recent = desktop.capabilities?.requests ? entries.value : (desktop.metrics?.recentEvents ?? [])
  return props.history ? recent : recent.slice(0, 5)
})
const rate = computed(() =>
  desktop.metrics?.requests ? `${Math.round((desktop.metrics.successes / desktop.metrics.requests) * 100)}%` : "n/a",
)
</script>
<template>
  <div v-if="!desktop.status.running && desktop.activeId === 'local'" class="panel empty">
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
      </div>
      <div class="stat">
        <div class="stat-label">Successful requests</div>
        <div class="stat-value mono success">{{ rate }}</div>
        <div class="stat-hint">{{ desktop.metrics?.successes ?? "n/a" }} completed</div>
      </div>
      <div class="stat">
        <div class="stat-label">Average response</div>
        <div class="stat-value mono">
          {{ desktop.metrics ? `${desktop.metrics.averageMs.toLocaleString()} ms` : "n/a" }}
        </div>
        <div class="stat-hint">Includes all execution tiers</div>
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
    <p v-if="desktop.capabilities?.requestEvents" class="text-xs muted" role="status">
      {{
        state === "live"
          ? "Live request updates"
          : state === "paused"
            ? "Live updates paused"
            : "Connecting live updates…"
      }}
    </p>
    <p v-if="feedError" class="notice error" role="alert">{{ feedError }}. Reconnecting automatically.</p>
    <RequestHistory
      :events="events"
      :instance-id="desktop.activeId"
      :show-date="history"
      :open-request-id="openRequestId"
      :active-requests="active"
      @close-request="emit('closeRequest')"
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
    <div v-if="history && desktop.capabilities?.requests" class="actions justify-between">
      <span class="text-xs muted">{{ events.length }} retained requests shown · Up to 500 per view</span>
      <UButton
        v-if="nextCursor && entries.length < 500"
        color="neutral"
        variant="outline"
        :loading="loadingMore"
        @click="loadMore"
        >Load older requests</UButton
      >
    </div>
    <p v-if="pageError" class="notice error" role="alert">{{ pageError }}</p>
  </template>
</template>
