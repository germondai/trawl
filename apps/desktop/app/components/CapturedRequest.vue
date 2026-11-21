<script setup lang="ts">
import type { RequestArtifact } from "@trawl/client"
import { jsonPreview } from "~/utils/json-preview"
import { t } from "~/utils/localization"

const props = defineProps<{
  input?: unknown
  artifact?: RequestArtifact
  loading: boolean
  error: string
  view: "headers" | "payload" | "cookies"
}>()
const emit = defineEmits<{ retry: [] }>()
const input = computed(() => props.input)
const parameters = computed<Record<string, unknown>>(() => {
  const record = input.value as { parameters?: unknown } | undefined
  const value = record?.parameters
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
})
const response = computed(() => {
  const value = (input.value as { response?: unknown } | undefined)?.response
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
})
const sections = computed(() =>
  props.view === "headers"
    ? [
        {
          label: t("ui.requestHeaders"),
          value: parameters.value.headers ?? {},
          recorded: true,
          empty: t("ui.noCustomHeaders"),
        },
        {
          label: t("ui.responseHeaders"),
          value: response.value?.headers,
          recorded: response.value?.headers !== undefined,
          empty: t("ui.noneRecorded"),
        },
      ]
    : [
        {
          label: t("ui.requestCookies"),
          value: parameters.value.cookies ?? [],
          recorded: true,
          empty: t("ui.noneRecorded"),
        },
        {
          label: t("ui.returnedCookies"),
          value: response.value?.cookies,
          recorded: response.value?.cookies !== undefined,
          empty: t("ui.noneRecorded"),
        },
      ],
)
const headerEntries = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).slice(0, 128) : []
const preview = computed(() => {
  if (!input.value || typeof input.value !== "object") return ""
  const record = input.value as { parameters?: Record<string, unknown>; bodyEncoding?: string }
  const parameters = record.parameters ?? {}
  if (props.view === "payload")
    return jsonPreview({
      body: parameters.body ?? parameters.postData ?? null,
      ...(record.bodyEncoding ? { encoding: record.bodyEncoding } : {}),
      options: Object.fromEntries(
        Object.entries(parameters).filter(
          ([key]) => !["url", "method", "headers", "cookies", "body", "postData"].includes(key),
        ),
      ),
    })
  return jsonPreview(input.value)
})
</script>
<template>
  <section class="form-stack" :aria-label="t('ui.savedRequestParameters')">
    <p v-if="!artifact" class="text-sm muted">
      {{ t("ui.requestParametersWereNotSavedEnable") }}
      <SettingLink name="HISTORY_CAPTURE_REQUESTS">{{ t("ui.requestCapture") }}</SettingLink>
      {{ t("ui.forFutureRequests") }}
    </p>
    <p v-else-if="artifact.state !== 'ready'" class="text-sm muted">
      {{
        artifact.state === "pending"
          ? t("ui.savingRequestParameters")
          : t("ui.requestInputUnavailable", { p0: artifact.reason ?? artifact.state })
      }}
    </p>
    <p v-else-if="loading" class="muted" role="status">{{ t("ui.loadingSavedRequest") }}</p>
    <p v-else-if="error" class="notice" role="alert">
      {{ error }} <UButton variant="link" @click="emit('retry')">{{ t("ui.retry") }}</UButton>
    </p>
    <template v-else-if="input">
      <template v-if="view === 'headers' || view === 'cookies'">
        <section v-for="section in sections" :key="section.label" class="form-stack">
          <h3 class="detail-section-title">{{ section.label }}</h3>
          <p v-if="!section.recorded" class="text-sm muted">{{ t("ui.notRecorded") }}</p>
          <template v-else-if="view === 'headers'">
            <dl v-if="headerEntries(section.value).length" class="request-details detail-metadata">
              <div v-for="[ name, value ] in headerEntries(section.value)" :key="name">
                <dt class="mono break-all">{{ name }}</dt>
                <dd class="mono break-all">{{ value }}</dd>
              </div>
            </dl>
            <p v-else class="text-sm muted">{{ section.empty }}</p>
          </template>
          <AppCodeBlock
            v-else-if="Array.isArray(section.value) && section.value.length"
            :code="jsonPreview(section.value)"
            language="JSON"
          />
          <p v-else class="text-sm muted">{{ section.empty }}</p>
        </section>
        <p class="text-xs muted">{{ t(view === "headers" ? "ui.recordedHeadersHelp" : "ui.recordedCookiesHelp") }}</p>
      </template>
      <template v-else>
        <h3 class="detail-section-title">{{ t("ui.requestPayloadAndOptions") }}</h3>
        <AppCodeBlock :code="preview" language="JSON" />
      </template>
    </template>
    <p v-else class="notice">{{ t("ui.savedRequestJsonCouldNotBeRead") }}</p>
  </section>
</template>
