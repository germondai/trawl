<script setup lang="ts">
import type { RequestArtifact } from "@trawl/client"
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"
import { jsonPreview } from "~/utils/json-preview"
import { capturedWorkbenchDraft, replacesWorkbenchDraft } from "~/utils/workbench"

const props = defineProps<{
  requestId: string
  requestAt: string
  artifact?: RequestArtifact
  view?: "headers" | "payload" | "cookies"
}>()
const emit = defineEmits<{ replay: [] }>()
const desktop = useDesktopStore()
const workbench = useWorkbenchStore()
const replace = shallowRef(false)
useNavigationModal(replace, false)
const replayError = shallowRef("")
const key = computed(() => `${desktop.activeId}:${desktop.active?.baseURL}:${props.requestId}:${props.requestAt}`)
const { bytes, loading, error, retry } = useCaptureArtifact(
  () => ({ id: props.requestId, at: props.requestAt }),
  () => props.artifact,
)
const input = computed(() => {
  if (!bytes.value) return undefined
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.value)) as unknown
  } catch {
    return undefined
  }
})
const parameters = computed<Record<string, unknown>>(() => {
  const record = input.value as { parameters?: unknown } | undefined
  const value = record?.parameters
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
})
const headers = computed(() => {
  const value = parameters.value.headers
  return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).slice(0, 128) : []
})
const copied = shallowRef(false)
const copyError = shallowRef("")
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
    copyError.value = "Clipboard is unavailable. Select and copy the values above."
  }
}
const preview = computed(() => {
  if (!input.value || typeof input.value !== "object") return ""
  const record = input.value as { parameters?: Record<string, unknown>; bodyEncoding?: string }
  const parameters = record.parameters ?? {}
  if (props.view === "headers")
    return jsonPreview({ url: parameters.url, method: parameters.method ?? "GET", headers: parameters.headers ?? {} })
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
  if (props.view === "cookies") return jsonPreview(parameters.cookies ?? [])
  return jsonPreview(input.value)
})
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
    replayError.value = cause instanceof Error ? cause.message : "Cannot open this request in the editor"
  }
}
watch(key, () => {
  replace.value = false
  replayError.value = ""
})
</script>
<template>
  <section class="form-stack" aria-label="Saved request parameters">
    <h3>
      {{
        view === "headers"
          ? "Request headers"
          : view === "payload"
            ? "Request payload and options"
            : view === "cookies"
              ? "Request cookies"
              : "Saved request"
      }}
    </h3>
    <p v-if="!artifact" class="text-xs muted">
      Request parameters were not saved. Enable
      <SettingLink name="HISTORY_CAPTURE_REQUESTS">request capture</SettingLink>
      for future requests.
    </p>
    <p v-else-if="artifact.state !== 'ready'" class="text-xs muted">
      {{
        artifact.state === "pending"
          ? "Saving request parameters…"
          : `Request input unavailable: ${artifact.reason ?? artifact.state}`
      }}
    </p>
    <template v-else>
      <p v-if="loading" class="muted" role="status">Loading saved request…</p>
      <p v-else-if="error" class="notice" role="alert">
        {{ error }} <UButton variant="link" @click="retry">Retry</UButton>
      </p>
      <template v-else-if="input">
        <dl v-if="view === 'headers'" class="request-details">
          <div>
            <dt>URL</dt>
            <dd class="mono break-all">{{ parameters.url }}</dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd class="mono">{{ parameters.method ?? "GET" }}</dd>
          </div>
          <div v-for="[ name, value ] in headers" :key="name">
            <dt class="mono break-all">{{ name }}</dt>
            <dd class="mono break-all">{{ value }}</dd>
          </div>
          <div v-if="!headers.length">
            <dt>Target headers</dt>
            <dd class="muted">No custom headers</dd>
          </div>
        </dl>
        <pre v-else class="request-input mono">{{ preview }}</pre>
        <div class="actions">
          <UButton icon="i-lucide-rotate-cw" @click="replay()">Edit and replay</UButton>
          <UButton
            color="neutral"
            variant="outline"
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            @click="copy"
            >{{
              copied ? "Copied" : "Copy request JSON"
            }}</UButton
          >
        </div>
        <p v-if="copyError" class="text-xs muted" role="status">{{ copyError }}</p>
      </template>
      <p v-else class="notice">Saved request JSON could not be read.</p>
      <p v-if="replayError" class="notice error" role="alert">{{ replayError }}</p>
    </template>
  </section>
  <UModal
    :open="replace"
    :content="confirmationContent"
    title="Replace the current request draft?"
    description="Your unsent draft will be replaced by the captured request. Nothing is sent until you press Send."
    @update:open="replace = $event"
    ><template #footer
      ><UButton color="neutral" variant="outline" @click="replace = false">Keep current draft</UButton
      ><UButton data-confirm-default @click="replay(true)">Replace draft</UButton></template
    ></UModal
  >
</template>
<style scoped>
.request-input {
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
</style>
