<script setup lang="ts">
import { scrollWorkspaceToTop } from "~/composables/useWorkspaceScroll"
import { formatLocale, t } from "~/utils/localization"

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
  desktop.metrics?.requests
    ? `${Math.round((desktop.metrics.successes / desktop.metrics.requests) * 100)}%`
    : t("ui.notAvailable"),
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
    <h2 class="mt-4">{{ t("ui.yourLocalScrapingEngine") }}</h2>
    <p v-if="!desktop.browser.installed">
      {{ t("ui.installTheVerifiedBrowserOnceThenStartTrawl") }}
    </p>
    <p v-else>{{ t("ui.startTheServerToAcceptApiRequestsAnd") }}</p>
    <UButton
      v-if="!desktop.browser.installed"
      icon="i-lucide-download"
      :loading="desktop.busy"
      :disabled="!desktop.native"
      @click="desktop.install"
      >{{
        t("ui.installBrowser")
      }}</UButton
    >
    <UButton v-else icon="i-lucide-play" :loading="desktop.busy" :disabled="!desktop.native" @click="desktop.start">{{
      t("ui.startServer")
    }}</UButton>
  </div>
  <template v-else>
    <div v-if="!history" class="stats">
      <div class="stat">
        <div class="stat-label">{{ t("ui.requestsLastHour") }}</div>
        <div class="stat-value mono">
          {{ desktop.metrics?.requests.toLocaleString(formatLocale()) ?? t("ui.notAvailable") }}
        </div>
        <div class="stat-hint">{{ t("ui.freshContentReusedClearance") }}</div>
        <MetricBar
          :value="desktop.metrics?.requests"
          :max="desktop.metrics?.retainedEvents"
          :label="
            t('overview.retainedRequests', {
              count: desktop.metrics?.requests ?? 0,
              retained: desktop.metrics?.retainedEvents ?? 0,
            })
          "
        />
      </div>
      <div class="stat">
        <div class="stat-label">{{ t("ui.successfulRequests") }}</div>
        <div class="stat-value mono success">{{ rate }}</div>
        <div class="stat-hint">{{ desktop.metrics?.successes ?? t("ui.notAvailable") }} {{ t("ui.completed") }}</div>
        <MetricBar
          :value="desktop.metrics?.successes"
          :max="desktop.metrics?.requests"
          :label="
            t('overview.results', {
              successes: desktop.metrics?.successes ?? 0,
              failures: desktop.metrics?.failures ?? 0,
            })
          "
          failed-remainder
        />
      </div>
      <div class="stat">
        <div class="stat-label">{{ t("ui.averageResponse") }}</div>
        <div class="stat-value mono">
          {{
            desktop.metrics ? `${desktop.metrics.averageMs.toLocaleString(formatLocale())} ms` : t("ui.notAvailable")
          }}
        </div>
        <div class="stat-hint">
          {{
            maximumMs == null
              ? t("ui.maximumNotReported")
              : maximumMs
                ? t("ui.longestRequestMs", { p0: maximumMs.toLocaleString(formatLocale()) })
                : t("ui.noCompletedRequests")
          }}
        </div>
        <MetricBar
          :value="desktop.metrics?.averageMs"
          :max="maximumMs"
          :label="
            maximumMs == null
              ? t('ui.maximumResponseTimeIsUnavailable')
              : t('ui.averageMsOfLongestMs', { p0: desktop.metrics?.averageMs ?? 0, p1: maximumMs })
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
        <h2>{{ t("ui.runningRequests") }}</h2>
        <span class="text-xs muted">{{
          activeTruncated ? t("ui.limitedActiveList") : t("counts.active", { count: active.length })
        }}</span>
      </div>
      <div v-for="request in active" :key="request.id" class="connection">
        <div>
          <strong>{{ request.domain }}</strong>
          <p class="text-xs muted">
            {{ request.method }} · {{ request.source }} {{ t("ui.started") }}
            {{ new Date(request.startedAt).toLocaleTimeString(formatLocale()) }}
          </p>
        </div>
        <span class="text-xs muted" role="status">{{ t("ui.running2") }}</span>
      </div>
      <p v-if="activeTruncated" class="panel-body text-xs muted">
        {{ t("ui.theActiveRequestListReachedItsDisplayLimit") }}
      </p>
    </div>
    <p v-if="feedError" class="notice error" role="alert">{{ t("errors.reconnecting", { error: feedError }) }}</p>
    <div v-if="history && queryable" class="history-toolbar">
      <UInput
        v-model="query.search"
        leading-icon="i-lucide-search"
        :ui="{ trailing: 'p-0' }"
        :placeholder="t('ui.searchDomainSourceCauseOrId')"
        :aria-label="t('ui.searchRequests')"
        data-type-focus
        :maxlength="200"
        class="grow min-w-48"
        ><template v-if="query.search" #trailing
          ><UButton
            icon="i-lucide-x"
            color="neutral"
            variant="link"
            class="search-clear"
            :aria-label="t('ui.clearRequestSearch')"
            @click="query.search = undefined"
          /></template
        ></UInput
      >
      <USelect
        v-model="sourceFilter"
        :items="[
          { label: t('ui.allSources'), value: 'all' },
          ...['native', 'flaresolverr', 'mcp', 'proxy'].map((value) => ({ label: value, value })),
        ]"
        :aria-label="t('ui.requestSource')"
      />
      <USelect
        v-model="resultFilter"
        :items="[
          { label: t('ui.allResults'), value: 'all' },
          { label: t('ui.success'), value: 'success' },
          { label: t('ui.failed'), value: 'failed' },
        ]"
        :aria-label="t('ui.requestResult')"
      />
      <USelect
        v-model="tierFilter"
        :items="[
          { label: t('ui.allTiers'), value: 'all' },
          ...[0, 1, 2, 3, 4].map((value) => ({ label: t('ui.tier2', { p0: value }), value: String(value) })),
        ]"
        :aria-label="t('ui.requestTier')"
      />
      <USelect
        v-model="query.sort"
        :items="[
          { label: t('ui.newestFirst'), value: 'newest' },
          { label: t('ui.oldestFirst'), value: 'oldest' },
          { label: t('ui.slowestFirst'), value: 'slowest' },
          { label: t('ui.fastestFirst'), value: 'fastest' },
        ]"
        :aria-label="t('ui.requestSort')"
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
            :aria-label="t('ui.showAllRequests')"
            @click="emit('showAll')"
            >{{
              t("ui.showAll")
            }}</UButton
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
