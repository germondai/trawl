<script setup lang="ts">
import type { SessionActivity } from "@trawl/client"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { formatLocale, LocalizedError, t } from "~/utils/localization"

const props = defineProps<{ sessionId?: string; requestId?: string }>()
const desktop = useDesktopStore()
const entries = shallowRef<SessionActivity[]>([])
const page = shallowRef(1)
const total = shallowRef(0)
const paginated = computed(() => Boolean(desktop.capabilities?.sessionActivityPagination))
const shown = computed(() =>
  paginated.value ? entries.value : entries.value.slice((page.value - 1) * 20, page.value * 20),
)
function changePage(value: number) {
  page.value = value
  if (paginated.value) void refresh()
}
const error = useErrorMessage()
const loading = shallowRef(false)
const selected = shallowRef<SessionActivity>()
const {
  manifest,
  loading: captureLoading,
  error: captureError,
} = useSavedCaptures(() => ({ id: selected.value?.id ?? "", at: selected.value?.at ?? "" }), "activity")
const artifact = computed(() => manifest.value?.artifacts.find((item) => item.kind === "request"))
useNavigationModal(selected, undefined)
const visible = useDocumentVisibility()
let controller: AbortController | undefined
async function refresh(background = false) {
  if (background && loading.value) return
  controller?.abort()
  const abort = new AbortController()
  controller = abort
  const id = desktop.activeId
  if (
    !desktop.capabilities?.sessionActivity ||
    (props.requestId && !desktop.capabilities.sessionActivityRequestIds) ||
    visible.value !== "visible"
  )
    return
  loading.value = true
  if (!background) error.value = ""
  try {
    const api = desktop.client().sessions
    const options = { signal: abort.signal, requestId: props.requestId }
    const values = paginated.value
      ? await api.activityPage(props.sessionId, { ...options, page: page.value, limit: 20 })
      : { entries: await api.activity(props.sessionId, options) }
    if (!abort.signal.aborted && id === desktop.activeId) {
      entries.value = values.entries
      total.value = "total" in values ? values.total : values.entries.length
      page.value = "page" in values ? values.page : Math.max(1, Math.min(page.value, Math.ceil(total.value / 20)))
      error.value = ""
    }
  } catch (cause) {
    if (!background && !abort.signal.aborted && id === desktop.activeId)
      error.value =
        cause instanceof Error || typeof cause === "string" ? cause : new LocalizedError("diagnostics.activityError")
  } finally {
    if (!abort.signal.aborted) loading.value = false
  }
}
watch(
  [
    () => desktop.activeId,
    () => props.sessionId,
    () => props.requestId,
    () => desktop.capabilities?.sessionActivity,
    paginated,
  ],
  () => {
    controller?.abort()
    selected.value = undefined
    entries.value = []
    page.value = 1
    total.value = 0
    loading.value = false
    void refresh()
  },
  { immediate: true },
)
const {
  bytes,
  loading: scriptLoading,
  error: scriptError,
} = useCaptureArtifact(
  () => ({ id: selected.value?.id ?? "", at: selected.value?.at ?? "" }),
  () => artifact.value,
  "activity",
)
const expression = computed(() => {
  if (!bytes.value) return undefined
  try {
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.value))
    return typeof input.parameters?.expression === "string" ? (input.parameters.expression as string) : undefined
  } catch {
    return undefined
  }
})
const poll = useIntervalFn(
  () => {
    if (desktop.health?.status === "ok") void refresh(true)
  },
  5000,
  { immediate: false },
)
watch(
  visible,
  (state) => {
    if (state === "visible") {
      poll.resume()
      void refresh(true)
    } else {
      poll.pause()
      controller?.abort()
      loading.value = false
    }
  },
  { immediate: true },
)
usePageRefresh(() => refresh())
onScopeDispose(() => controller?.abort())
</script>
<template>
  <div v-if="desktop.capabilities?.sessionActivity" class="activity-results">
    <section class="panel">
      <div class="panel-heading">
        <h2>{{ t(requestId ? "diagnostics.requestActivity" : "diagnostics.activity") }}</h2>
      </div>
      <div v-if="error || !entries.length" class="panel-body">
        <p v-if="error" class="notice" role="alert">{{ error }}</p>
        <p v-else class="muted" role="status">
          {{ loading ? t("ui.loading") : t(requestId ? "diagnostics.noRequestActivity" : "diagnostics.noActivity") }}
        </p>
      </div>
      <div v-else class="table-wrap">
        <table class="request-table activity-table">
          <thead>
            <tr>
              <th>{{ t("ui.recordedAt") }}</th>
              <th>{{ t("ui.session") }}</th>
              <th>{{ t("ui.result") }}</th>
              <th>{{ t("ui.duration") }}</th>
              <th>{{ t("diagnostics.scriptSize") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in shown" :key="entry.id">
              <td class="mono muted">
                {{
                  new Date(entry.at).toLocaleTimeString(formatLocale(), {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                }}
                <div class="text-xs mt-1">{{ new Date(entry.at).toLocaleDateString(formatLocale()) }}</div>
              </td>
              <td>
                <UButton
                  class="request-target"
                  :label="entry.sessionId"
                  trailing-icon="i-lucide-chevron-right"
                  color="neutral"
                  variant="link"
                  @click="selected = entry"
                />
              </td>
              <td>
                <span class="status"
                  ><span class="dot" :class="{ ready: entry.success, failed: !entry.success }" />
                  {{ t(entry.success ? "ui.success" : "ui.failed") }}</span
                >
              </td>
              <td class="mono">{{ entry.durationMs.toLocaleString(formatLocale()) }} {{ t("ui.ms") }}</td>
              <td class="mono muted">{{ entry.scriptBytes.toLocaleString(formatLocale()) }} B</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="panel-footer text-xs muted">
        {{ t(requestId ? "diagnostics.requestActivityHelp" : "diagnostics.activityHelp") }}
      </div>
    </section>
    <div v-if="total > 20" class="flex justify-center">
      <UPagination
        :page="page"
        :items-per-page="20"
        :total="total"
        :disabled="loading"
        :sibling-count="1"
        :ui="{ first: 'hidden', last: 'hidden' }"
        @update:page="changePage"
      />
    </div>
  </div>
  <AppDialog
    :open="!!selected"
    :title="t('diagnostics.scriptDetails')"
    :description="selected?.sessionId"
    @update:open="
      (value) => {
        if (!value) selected = undefined
      }
    "
  >
    <template #body
      ><div v-if="selected" class="form-stack">
        <dl class="request-details detail-metadata">
          <div>
            <dt>{{ t("ui.recordedAt") }}</dt>
            <dd>{{ new Date(selected.at).toLocaleString(formatLocale(), { timeZoneName: "short" }) }}</dd>
          </div>
          <div>
            <dt>{{ t("ui.resultCause") }}</dt>
            <dd>{{ selected.cause ? t(`diagnostics.cause.${selected.cause}`) : t("ui.success") }}</dd>
          </div>
          <div>
            <dt>{{ t("ui.duration") }}</dt>
            <dd class="mono">{{ selected.durationMs.toLocaleString(formatLocale()) }} {{ t("ui.ms") }}</dd>
          </div>
        </dl>
        <p v-if="captureLoading || scriptLoading" role="status">{{ t("ui.loading") }}</p>
        <p v-else-if="captureError || scriptError" class="notice" role="alert">{{ captureError || scriptError }}</p>
        <template v-else-if="expression !== undefined"
          ><AppCodeBlock :code="expression.slice(0, 65536)" language="JavaScript" />
          <p v-if="expression.length > 65536" class="text-xs muted">{{ t("diagnostics.scriptTruncated") }}</p></template
        >
        <p v-else class="text-sm muted">{{ t("diagnostics.scriptMissing") }}</p>
        <details class="detail-identifiers">
          <summary>{{ t("diagnostics.identifiers") }}</summary>
          <dl class="request-details detail-metadata mt-4">
            <div>
              <dt>{{ t("diagnostics.activityId") }}</dt>
              <dd class="mono break-all">{{ selected.id }}</dd>
            </div>
            <div v-if="selected.requestId">
              <dt>{{ t("ui.requestId") }}</dt>
              <dd class="mono break-all">{{ selected.requestId }}</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd class="mono break-all">{{ selected.scriptHash }}</dd>
            </div>
          </dl>
        </details>
      </div></template
    >
  </AppDialog>
</template>
<style scoped>
.activity-results {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.activity-results > .panel {
  margin-bottom: 0;
}
.activity-table .request-target {
  max-width: 280px;
}
.detail-identifiers summary {
  cursor: pointer;
  color: var(--ui-text-muted);
  font-size: 13px;
}
</style>
