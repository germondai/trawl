<script setup lang="ts">
import type { ActiveRequest, DashboardEvent, RequestHistoryEntry } from "@trawl/client"
import RequestInspector from "~/components/RequestInspector.vue"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { formatLocale, LocalizedError, t } from "~/utils/localization"

const props = defineProps<{
  events: (DashboardEvent & Partial<RequestHistoryEntry>)[]
  instanceId: string
  showDate?: boolean
  openRequestId?: string
  activeRequests?: ActiveRequest[]
}>()
const emit = defineEmits<{ closeRequest: []; replay: [] }>()
const inspector = useTemplateRef<InstanceType<typeof RequestInspector>>("inspector")
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
const detailError = useErrorMessage()
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
        detailError.value =
          cause instanceof Error || typeof cause === "string"
            ? cause
            : new LocalizedError("ui.retainedDetailIsUnavailable")
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
  new Date(value).toLocaleTimeString(formatLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })
</script>
<template>
  <section class="panel" :aria-label="t('ui.recentRequests')">
    <div class="panel-heading" data-tour="request-history">
      <h2>{{ t("ui.recentRequests") }}</h2>
      <slot name="actions"><span class="status">{{ events.length }} {{ t("ui.shown") }}</span></slot>
    </div>
    <div v-if="!events.length" class="empty">{{ t("ui.apiActivityWillAppearHere") }}</div>
    <div v-else class="table-wrap">
      <table class="request-table">
        <thead>
          <tr>
            <th>{{ t("ui.recordedAt") }}</th>
            <th>{{ t("ui.target") }}</th>
            <th>{{ t("ui.source") }}</th>
            <th>{{ t("ui.result") }}</th>
            <th>{{ t("ui.tier") }}</th>
            <th>{{ t("ui.duration") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(event, index) in events" :key="event.id ?? `${event.at}-${index}`">
            <td class="mono muted">
              {{ time(event.at) }}
              <div v-if="showDate" class="text-xs mt-1">
                {{ new Date(event.at).toLocaleDateString(formatLocale()) }}
              </div>
            </td>
            <td>
              <UButton
                class="request-target"
                :label="event.domain"
                :ui="{ label: 'truncate', trailingIcon: 'shrink-0' }"
                trailing-icon="i-lucide-chevron-right"
                :aria-label="t('ui.viewRequestToAt', { p0: event.domain, p1: time(event.at) })"
                color="neutral"
                variant="link"
                @click="selection = event"
              />
            </td>
            <td class="muted">{{ event.source }}</td>
            <td>
              <span class="status"
                ><span class="dot" :class="{ ready: event.success, failed: !event.success }" />
                {{ event.success ? t("ui.success") : event.category || t("ui.failed")
                }}<span v-if="event.statusCode" class="mono text-xs muted">{{ event.statusCode }}</span></span
              >
            </td>
            <td class="mono muted">{{ event.tier ?? t("ui.notAvailable") }}</td>
            <td class="mono">{{ event.durationMs.toLocaleString(formatLocale()) }} {{ t("ui.ms") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <AppDialog
    :open="Boolean(selection)"
    :title="t('ui.requestDetails')"
    :description="t('ui.recordedMetadataForThisRequest')"
    :close="false"
    :ui="{
      content: 'request-detail-dialog',
      header: 'gap-3 items-center',
      wrapper: 'flex-1 min-w-0',
    }"
    @update:open="if (!$event) close();"
  >
    <template #actions>
      <div class="flex shrink-0 gap-1">
        <AppTooltip :text="t('ui.editAndReplay')">
          <UButton
            icon="i-lucide-rotate-cw"
            color="neutral"
            variant="ghost"
            :aria-label="t('ui.editAndReplay')"
            :disabled="!inspector?.available"
            @click="inspector?.replay()"
          />
        </AppTooltip>
        <AppTooltip :text="t('ui.copyRequestJson')">
          <UButton
            :icon="inspector?.copied ? 'i-lucide-check' : 'i-lucide-copy'"
            color="neutral"
            variant="ghost"
            :aria-label="t('ui.copyRequestJson')"
            :disabled="!inspector?.available"
            @click="inspector?.copy()"
          />
        </AppTooltip>
        <AppTooltip :text="t('ui.close', { p0: t('ui.requestDetails') })">
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            :aria-label="t('ui.close', { p0: t('ui.requestDetails') })"
            @click="close"
          />
        </AppTooltip>
      </div>
    </template>
    <template #body
      ><p v-if="!selected" class="muted" role="status">
        {{
          unavailable
            ? t("ui.requestHistoryIsUnavailableOnThisInstanceEnable")
            : running
              ? t("ui.thisRequestIsStillRunningDetailsWillAppear", { p0: running.method, p1: running.domain })
              : detailError || t("ui.loadingRetainedRequestDetails")
        }}
      </p>
      <p v-if="running && selectedId" class="mono text-xs break-all">{{ selectedId }}</p>
      <template v-if="selected">
        <div class="request-detail-target">
          <span class="status"
            ><span class="dot" :class="{ ready: selected.success, failed: !selected.success }" />
            {{ selected.success ? t("ui.success") : t("ui.failed") }}</span
          >
          <h3>{{ selected.domain }}</h3>
        </div>
        <p v-if="detailError" class="text-xs muted" role="status">
          {{ t("errors.originalMetadata", { error: detailError }) }}
        </p>
        <RequestInspector
          ref="inspector"
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
  </AppDialog>
</template>

<style>
.request-detail-dialog:not(.app-drawer) {
  width: min(1024px, calc(100vw - 64px));
  max-width: none;
  min-width: 0;
  height: min(860px, calc(100dvh - 104px));
  max-height: calc(100dvh - 104px);
  top: calc(50dvh + 28px);
}
.request-detail-dialog [data-slot="body"] {
  min-width: 0;
  scrollbar-gutter: stable;
}
</style>
