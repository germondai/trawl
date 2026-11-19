<script setup lang="ts">
import type { ActiveRequest, DashboardEvent, RequestHistoryEntry } from "@trawl/client"
import { useNavigationModal } from "~/composables/useNavigationSteps"

const props = defineProps<{
  events: (DashboardEvent & Partial<RequestHistoryEntry>)[]
  instanceId: string
  showDate?: boolean
  openRequestId?: string
  activeRequests?: ActiveRequest[]
}>()
const emit = defineEmits<{ closeRequest: []; replay: [] }>()
const desktop = useDesktopStore()
const selection = shallowRef<DashboardEvent | string | null>(props.openRequestId ?? null)
useNavigationModal(selection, null)
watch(
  () => props.openRequestId,
  (id) => {
    if (id) selection.value = id
    else if (typeof selection.value === "string") selection.value = null
  },
)
const detail = shallowRef<RequestHistoryEntry>()
const detailError = shallowRef("")
const selected = computed<(DashboardEvent & Partial<RequestHistoryEntry>) | null>(
  () => detail.value ?? (typeof selection.value === "string" ? null : selection.value),
)
const selectedId = computed(() => (typeof selection.value === "string" ? selection.value : selection.value?.id))
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
    const id = typeof row === "string" ? row : row?.id
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
}
watch(
  selection,
  (value) => {
    if (value === null) emit("closeRequest")
  },
  { flush: "sync" },
)
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
            <th>Source</th>
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
            <td class="muted">{{ event.source }}</td>
            <td>
              <span class="status"
                ><span class="dot" :class="{ ready: event.success, failed: !event.success }" />
                {{ event.success ? "Success" : event.category || "Failed"
                }}<span v-if="event.statusCode" class="mono text-xs muted">{{ event.statusCode }}</span></span
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
    :open="Boolean(selection)"
    title="Request details"
    description="Recorded metadata for this request."
    :ui="{ content: 'sm:max-w-5xl h-[min(860px,calc(100dvh-48px))]', close: 'top-1/2 -translate-y-1/2 end-6' }"
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
        <RequestInspector
          :key="selected.id ?? selected.at"
          :entry="selected"
          :captures="Boolean(canViewCaptures)"
          @replay="
            close();
            emit('replay');
          "
        />
      </template></template
    >
  </UModal>
</template>
