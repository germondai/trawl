<script setup lang="ts">
import type { DashboardEvent, RequestHistoryEntry } from "@trawl/client"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { confirmationContent, useNavigationModal, useNavigationSelection } from "~/composables/useNavigationSteps"
import { executionTier } from "~/utils/dashboard"
import { formatLocale, LocalizedError, t } from "~/utils/localization"
import { capturedWorkbenchDraft, replacesWorkbenchDraft } from "~/utils/workbench"

const props = defineProps<{ entry: DashboardEvent & Partial<RequestHistoryEntry>; captures: boolean }>()
const emit = defineEmits<{ replay: [] }>()
const tab = shallowRef("headers")
useNavigationSelection("request-inspector", tab, { transient: true })
const tabs = computed(() => [
  { label: t("ui.headers"), value: "headers" },
  ...(!["GET", "HEAD"].includes(props.entry.method ?? "GET") ? [{ label: t("ui.payload"), value: "payload" }] : []),
  { label: t("ui.cookies"), value: "cookies" },
  { label: t("ui.timing"), value: "timing" },
  { label: t("ui.initiator"), value: "initiator" },
  { label: t("ui.response"), value: "response" },
])
watch(tabs, (items) => {
  if (!items.some((item) => item.value === tab.value)) tab.value = "headers"
})
const { manifest, loading, error } = useSavedCaptures(() => ({ id: props.entry.id ?? "", at: props.entry.at }))
const request = computed(() => manifest.value?.artifacts.find((artifact) => artifact.kind === "request"))
const diagnostics = computed(() => props.entry.diagnostics)
const bytes = (value?: number) =>
  value === undefined
    ? t("ui.notRecorded")
    : value < 1024
      ? `${value} B`
      : `${(value / 1024).toLocaleString(formatLocale(), { maximumFractionDigits: 1 })} KiB`

const desktop = useDesktopStore()
const workbench = useWorkbenchStore()
const replace = shallowRef(false)
useNavigationModal(replace, false)
const replayError = useErrorMessage()
const {
  bytes: inputBytes,
  loading: inputLoading,
  error: inputError,
  retry,
} = useCaptureArtifact(
  () => ({ id: props.entry.id ?? "", at: props.entry.at }),
  () => request.value,
)
const input = computed<unknown>(() => {
  if (!inputBytes.value) return undefined
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes.value))
  } catch {
    return undefined
  }
})
const url = computed(() => {
  const value = input.value as { parameters?: { url?: unknown } } | undefined
  return typeof value?.parameters?.url === "string" ? value.parameters.url : undefined
})
const copied = shallowRef(false)
const copyError = useErrorMessage()
const { start: clearCopied } = useTimeoutFn(
  () => {
    copied.value = false
  },
  2000,
  { immediate: false },
)
async function copy() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(input.value, null, 2))
    copied.value = true
    copyError.value = ""
    clearCopied()
  } catch {
    copyError.value = new LocalizedError("ui.clipboardIsUnavailableSelectAndCopyTheValues")
  }
}
function replay(confirmed = false) {
  replace.value = false
  replayError.value = ""
  try {
    const draft = capturedWorkbenchDraft(input.value)
    if (!confirmed && replacesWorkbenchDraft(workbench.draft, draft)) {
      replace.value = true
      return
    }
    workbench.draft = draft
    emit("replay")
  } catch (cause) {
    replayError.value =
      cause instanceof Error || typeof cause === "string"
        ? cause
        : new LocalizedError("ui.cannotOpenThisRequestInTheEditor")
  }
}
defineExpose({ copy, replay, copied, available: computed(() => !!input.value) })
</script>
<template>
  <div class="form-stack request-inspector">
    <p v-if="copyError || replayError" class="notice" role="alert">{{ copyError || replayError }}</p>
    <dl class="inspection-facts">
      <div>
        <dt>{{ t("ui.source") }}</dt>
        <dd>{{ entry.source }}</dd>
      </div>
      <div>
        <dt>{{ t("ui.execution") }}</dt>
        <dd>{{ executionTier(entry.tier) }} <span class="muted">· {{ entry.tier ?? "—" }}</span></dd>
      </div>
      <div>
        <dt>{{ t("ui.httpStatus") }}</dt>
        <dd class="mono">{{ entry.statusCode ?? t("ui.notRecorded") }}</dd>
      </div>
      <div>
        <dt>{{ t("ui.challenge") }}</dt>
        <dd>{{ diagnostics?.challenges.join(", ") || (diagnostics ? t("ui.noneRecorded") : t("ui.notRecorded")) }}</dd>
      </div>
      <div>
        <dt>{{ t("ui.resultCause") }}</dt>
        <dd>
          {{
            diagnostics?.cause
              ? t(`diagnostics.cause.${diagnostics.cause}`)
              : entry.success
                ? t("ui.success")
                : (entry.category ?? entry.tierStatus ?? t("ui.failed"))
          }}
        </dd>
      </div>
      <div>
        <dt>{{ t("ui.responseType") }}</dt>
        <dd>{{ diagnostics?.contentType ?? diagnostics?.responseKind ?? t("ui.notRecorded") }}</dd>
      </div>
      <div>
        <dt>{{ t("ui.requestBody") }}</dt>
        <dd>{{ bytes(diagnostics?.requestBodyBytes) }}</dd>
      </div>
      <div>
        <dt>{{ t("ui.responseBody") }}</dt>
        <dd>{{ bytes(diagnostics?.responseBytes) }}</dd>
      </div>
    </dl>
    <dl class="inspection-facts inspection-general">
      <div v-if="url" class="inspection-url">
        <dt>URL</dt>
        <dd class="mono break-all">{{ url }}</dd>
      </div>
      <div class="inspection-id">
        <dt>{{ t("ui.requestId") }}</dt>
        <dd class="mono break-all">{{ entry.id ?? t("ui.notRecorded") }}</dd>
      </div>
      <div>
        <dt>{{ t("ui.method") }}</dt>
        <dd class="mono">{{ entry.method ?? t("ui.notRecorded") }}</dd>
      </div>
      <div>
        <dt>{{ t("ui.recordedAt") }}</dt>
        <dd>{{ new Date(entry.at).toLocaleString(formatLocale(), { timeZoneName: "short" }) }}</dd>
      </div>
      <div v-if="entry.waf">
        <dt>{{ t(entry.waf.products.length ? "ui.wafProvider" : "diagnostics.stage.waf-detection") }}</dt>
        <dd>{{ entry.waf.products.join(", ") || t(`diagnostics.waf.${entry.waf.state}`) }}</dd>
      </div>
    </dl>
    <UTabs
      class="inspection-tabs"
      v-model="tab"
      :items="tabs"
      :content="false"
      variant="link"
      :ui="{ list: 'w-full justify-start', trigger: 'shrink-0' }"
    />
    <template v-if="tab === 'headers' || tab === 'payload' || tab === 'cookies'">
      <p v-if="error" class="notice" role="status">{{ error }}</p>
      <CapturedRequest
        v-if="captures && entry.id && manifest"
        :input="input"
        :loading="inputLoading"
        :error="inputError"
        :artifact="request"
        :view="tab"
        @retry="retry"
      />
      <p v-else-if="loading" class="text-xs muted" role="status">{{ t("ui.loadingSavedRequestParameters") }}</p>
      <p v-else class="text-xs muted">{{ t("ui.savedRequestParametersAreUnavailableOnThisInstance") }}</p>
    </template>
    <RequestExecution v-else-if="tab === 'timing'" :diagnostics="diagnostics" :duration-ms="entry.durationMs" />
    <div v-else-if="tab === 'initiator'" class="form-stack">
      <dl class="request-details detail-metadata">
        <div>
          <dt>{{ t("ui.source") }}</dt>
          <dd>
            {{ entry.source === "flaresolverr" ? t("ui.flaresolverrApiProwlarrAndCompatibleClients") : entry.source }}
          </dd>
        </div>
        <div>
          <dt>{{ t("ui.target") }}</dt>
          <dd>{{ entry.domain }}</dd>
        </div>
        <div>
          <dt>{{ t("ui.timestampUtc") }}</dt>
          <dd class="mono break-all">{{ entry.at }}</dd>
        </div>
        <div v-if="diagnostics?.operation">
          <dt>{{ t("diagnostics.operation") }}</dt>
          <dd>{{ diagnostics.operation }}</dd>
        </div>
        <div v-if="diagnostics?.sessionId">
          <dt>{{ t("ui.session") }}</dt>
          <dd class="mono break-all">{{ diagnostics.sessionId }}</dd>
        </div>
        <div v-if="diagnostics?.cause">
          <dt>{{ t("ui.resultCause") }}</dt>
          <dd>{{ t(`diagnostics.cause.${diagnostics.cause}`) }}</dd>
        </div>
      </dl>
      <SessionActivity
        v-if="diagnostics?.sessionId && entry.id"
        :session-id="diagnostics.sessionId"
        :request-id="entry.id"
      />
    </div>
    <CapturedContent
      v-else-if="tab === 'response' && captures && entry.id"
      :request-id="entry.id"
      :request-at="entry.at"
    />
    <p v-else-if="tab === 'response'" class="text-sm muted">
      {{ t("ui.savedResponseContentIsUnavailableOnThisInstance") }}
    </p>
  </div>
  <AppDialog
    v-model:open="replace"
    :content="confirmationContent"
    :title="t('ui.replaceTheCurrentRequestDraft')"
    :description="t('ui.yourUnsentDraftWillBeReplacedByThe')"
    ><template #footer
      ><UButton color="neutral" variant="outline" @click="replace = false">{{ t("ui.keepCurrentDraft") }}</UButton
      ><UButton data-confirm-default @click="replay(true)">{{ t("ui.replaceDraft") }}</UButton></template
    ></AppDialog
  >
</template>
<style scoped>
.inspection-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px 16px;
  margin: 0;
}
.inspection-general .inspection-url {
  grid-column: 1 / -1;
}
.inspection-general .inspection-id {
  grid-column: span 2;
}
.inspection-facts dt {
  font-size: 12px;
  color: var(--ui-text-muted);
  margin-bottom: 6px;
}
.inspection-facts dd {
  margin: 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}
@media (max-width: 720px) {
  .inspection-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
