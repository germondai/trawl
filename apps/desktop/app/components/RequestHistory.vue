<script setup lang="ts">
import type { ActiveRequest, DashboardEvent, RequestHistoryEntry } from "@trawl/client"
import { executionTier } from "~/utils/dashboard"

const props = defineProps<{
  events: DashboardEvent[]
  instanceId: string
  showDate?: boolean
  openRequestId?: string
  activeRequests?: ActiveRequest[]
}>()
const emit = defineEmits<{ closeRequest: [] }>()
const desktop = useDesktopStore()
const selection = shallowRef<DashboardEvent | null>(null)
const detail = shallowRef<RequestHistoryEntry>()
const detailError = shallowRef("")
const selected = computed<(DashboardEvent & Partial<RequestHistoryEntry>) | null>(() => detail.value ?? selection.value)
const selectedId = computed(() => selection.value?.id ?? props.openRequestId)
const running = computed(() => props.activeRequests?.find((row) => row.id === selectedId.value))
const retained = computed(() => props.events.find((row) => row.id === selectedId.value))
const unavailable = computed(
  () => desktop.capabilities === null || (desktop.capabilities && !desktop.capabilities.requests),
)
const canViewCaptures = computed(() => desktop.native && desktop.capabilities?.captures)
watch(
  [
    selection,
    () => props.instanceId,
    () => props.openRequestId,
    () => desktop.capabilities?.requests,
    running,
    retained,
  ],
  async ([row, , openId], _, onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    detail.value = undefined
    detailError.value = ""
    const id = row?.id ?? openId
    if (!id || !desktop.capabilities?.requests) return
    if (running.value) return
    try {
      const value = await desktop.client().requests.get(id, { signal: controller.signal })
      if (!controller.signal.aborted) detail.value = value
    } catch (cause) {
      if (!controller.signal.aborted)
        detailError.value = cause instanceof Error ? cause.message : "Retained detail is unavailable"
    }
  },
  { immediate: true },
)
function close() {
  selection.value = null
  emit("closeRequest")
}
watch(
  () => props.instanceId,
  () => {
    close()
  },
)
const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
</script>
<template>
  <section class="panel" aria-label="Recent requests">
    <div class="panel-heading">
      <h2>Recent requests</h2>
      <slot name="actions"><span class="status">{{ events.length }} shown</span></slot>
    </div>
    <div v-if="!events.length" class="empty">API activity will appear here</div>
    <div v-else class="table-wrap">
      <table class="request-table">
        <thead>
          <tr>
            <th>Recorded at</th>
            <th>Target</th>
            <th>Result</th>
            <th>Tier</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(event, index) in events" :key="event.id ?? `${event.at}-${index}`">
            <td class="mono muted">
              {{ time(event.at) }}
              <div v-if="showDate" class="text-xs mt-1">{{ new Date(event.at).toLocaleDateString() }}</div>
            </td>
            <td>
              <UButton
                class="request-target"
                :label="event.domain"
                :ui="{ label: 'truncate', trailingIcon: 'shrink-0' }"
                trailing-icon="i-lucide-chevron-right"
                :aria-label="`View request to ${event.domain} at ${time(event.at)}`"
                color="neutral"
                variant="link"
                @click="selection = event"
              />
            </td>
            <td>
              <span class="status"
                ><span class="dot" :class="{ ready: event.success, failed: !event.success }" />
                {{ event.success ? "Success" : event.category || "Failed" }}</span
              >
            </td>
            <td class="mono muted">{{ event.tier ?? "n/a" }}</td>
            <td class="mono">{{ event.durationMs.toLocaleString() }} ms</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <UModal
    :open="Boolean(selected || openRequestId)"
    title="Request details"
    description="Recorded metadata for this request."
    :ui="{ content: canViewCaptures ? 'sm:max-w-4xl' : '' }"
    @update:open="if (!$event) close();"
  >
    <template #body
      ><p v-if="!selected" class="muted" role="status">
        {{
          unavailable
            ? "Request history is unavailable on this instance. Enable observability on its host to retain future requests."
            : running
              ? `This request is still running (${running.method} ${running.domain}). Details will appear after completion.`
              : detailError || "Loading retained request details…"
        }}
      </p>
      <p v-if="running && selectedId" class="mono text-xs break-all">{{ selectedId }}</p>
      <template v-if="selected">
        <div class="request-detail-target">
          <span class="status"
            ><span class="dot" :class="{ ready: selected.success, failed: !selected.success }" />
            {{ selected.success ? "Success" : "Failed" }}</span
          >
          <h3>{{ selected.domain }}</h3>
        </div>
        <p v-if="detailError" class="text-xs muted" role="status">
          {{ detailError }}. Showing the original recorded metadata.
        </p>
        <dl class="request-details">
          <div v-if="selected.id">
            <dt>Request ID</dt>
            <dd class="mono break-all">{{ selected.id }}</dd>
          </div>
          <div v-if="selected.method">
            <dt>Method</dt>
            <dd class="mono">{{ selected.method }}</dd>
          </div>
          <div>
            <dt>Recorded at</dt>
            <dd>{{ new Date(selected.at).toLocaleString() }}</dd>
          </div>
          <div>
            <dt>Timestamp (UTC)</dt>
            <dd class="mono">{{ selected.at }}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd class="mono">{{ selected.durationMs.toLocaleString() }} ms</dd>
          </div>
          <div>
            <dt>HTTP status</dt>
            <dd class="mono">{{ selected.statusCode ?? "Not recorded" }}</dd>
          </div>
          <div>
            <dt>Execution tier</dt>
            <dd>{{ selected.tier !== null ? `${selected.tier} · ` : "" }}{{ executionTier(selected.tier) }}</dd>
          </div>
          <div>
            <dt>Request source</dt>
            <dd>{{ selected.source }}</dd>
          </div>
          <div v-if="selected.tierStatus">
            <dt>Tier outcome</dt>
            <dd>{{ selected.tierStatus }}</dd>
          </div>
          <div v-if="selected.waf">
            <dt>WAF diagnostics</dt>
            <dd>{{ selected.waf.products.join(", ") || selected.waf.state }}</dd>
          </div>
          <div v-if="selected.category">
            <dt>Failure category</dt>
            <dd>{{ selected.category }}</dd>
          </div>
          <div v-if="selected.severity">
            <dt>Severity</dt>
            <dd>{{ selected.severity }}</dd>
          </div>
        </dl>
        <CapturedContent
          v-if="selected.id && canViewCaptures"
          :key="selected.id"
          :request-id="selected.id"
          :request-at="selected.at"
        />
        <p v-else class="request-retention-note">
          Saved response content is unavailable on this instance. The recorded metadata remains readable.
        </p>
      </template></template
    >
    <template #footer><UButton color="neutral" variant="outline" @click="close">Close details</UButton></template>
  </UModal>
</template>
