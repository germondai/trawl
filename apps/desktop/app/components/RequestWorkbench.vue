<script setup lang="ts">
import type { BrowserSession } from "@trawl/client"
import { useWorkbenchRun } from "~/composables/useWorkbenchRun"
import { useDesktopStore } from "~/stores/desktop"
import { useWorkbenchStore } from "~/stores/workbench"
import { targetMethods, workbenchOutputs } from "~/utils/workbench"

const emit = defineEmits<{ history: [id: string] }>()
const desktop = useDesktopStore()
const { draft } = storeToRefs(useWorkbenchStore())
const { state, error, failureDetails, result, requestId, requestIdConfirmed, elapsed, send, stop } = useWorkbenchRun()
const native = computed(() => desktop.native)
const historyAvailable = computed(() => Boolean(desktop.capabilities?.requests))
const sessions = shallowRef<BrowserSession[]>([])
const sessionError = shallowRef("")
const loadingSessions = shallowRef(false)
const reveal = shallowRef(false)
const sessionItems = computed(() => sessions.value.map((session) => ({ label: session.id, value: session.id })))
const pending = computed(() => state.value === "pending")
let sessionController: AbortController | undefined
async function loadSessions() {
  sessionController?.abort()
  const controller = new AbortController()
  sessionController = controller
  loadingSessions.value = true
  sessionError.value = ""
  try {
    const values = await desktop.client().sessions.list({ signal: controller.signal })
    if (!controller.signal.aborted) sessions.value = values
  } catch (cause) {
    if (!controller.signal.aborted)
      sessionError.value = cause instanceof Error ? cause.message : "Could not list sessions"
  } finally {
    if (!controller.signal.aborted) loadingSessions.value = false
  }
}
watch(
  () => desktop.activeId,
  () => {
    sessionController?.abort()
    sessions.value = []
    sessionError.value = ""
    loadingSessions.value = false
    reveal.value = false
  },
)
onScopeDispose(() => sessionController?.abort())
</script>
<template>
  <p class="section-intro">Send a request through {{ desktop.active?.name }} using the native TRAWL API.</p>
  <form class="panel" @submit.prevent="send(draft)">
    <div class="panel-heading">
      <h2>New request</h2>
      <span class="text-xs muted">Draft kept in memory</span>
    </div>
    <fieldset class="panel-body form-stack" :disabled="pending">
      <div class="target-row">
        <UFormField label="Target method"><USelect v-model="draft.method" :items="[...targetMethods]" /></UFormField>
        <UFormField label="Target URL" required class="min-w-0"
          ><UInput
            v-model="draft.url"
            type="url"
            required
            :maxlength="8192"
            placeholder="https://example.com"
            class="w-full"
            autocomplete="off"
            spellcheck="false"
          /></UFormField
        >
      </div>
      <div class="options-row">
        <UFormField label="Output"
          ><USelect v-model="draft.output" :items="[...workbenchOutputs]" class="w-full" /></UFormField
        >
        <UFormField label="Timeout (seconds)"
          ><UInput v-model.number="draft.timeout" type="number" :min="1" :max="180" required /></UFormField
        >
        <UFormField label="Maximum tier"
          ><USelect
            v-model="draft.maxTier"
            :items="[
              { label: 'All tiers (4)', value: 4 },
              { label: 'Up to tier 3', value: 3 },
              { label: 'Up to tier 2', value: 2 },
              { label: 'HTTP only (1)', value: 1 },
            ]"
          /></UFormField
        >
      </div>
      <div class="options-row">
        <UFormField label="Session" description="Reuse an existing session or enter its ID.">
          <UInput
            v-model="draft.sessionId"
            :maxlength="128"
            placeholder="Optional session ID"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Available sessions"
          ><USelect
            v-model="draft.sessionId"
            :items="sessionItems"
            placeholder="Select a loaded session"
            class="w-full"
          /></UFormField
        >
        <div class="self-end">
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            :loading="loadingSessions"
            :disabled="!native"
            @click="loadSessions"
            >Load sessions</UButton
          >
        </div>
      </div>
      <p v-if="sessionError" class="notice error" role="alert">{{ sessionError }}</p>
      <div v-if="draft.output === 'extract'">
        <UFormField
          label="Extraction options (JSON)"
          description="CSS itemSelector, fields with selector/attribute, and optional maxItems/render."
        >
          <UTextarea v-model="draft.extraction" :maxlength="32768" :rows="7" class="w-full mono" spellcheck="false" />
        </UFormField>
      </div>
      <UFormField label="Body"
        ><USelect
          v-model="draft.bodyMode"
          :items="[
            { label: 'No body', value: 'none' },
            { label: 'JSON object or array', value: 'json' },
            { label: 'Text', value: 'text' },
          ]"
        /></UFormField
      >
      <UFormField
        v-if="draft.bodyMode !== 'none'"
        label="Target request body"
        :description="
          draft.bodyMode === 'json'
            ? 'JSON is serialized and Content-Type is set automatically.'
            : 'Content-Type defaults to text/plain. Override it in target headers if needed.'
        "
      >
        <UTextarea
          v-model="draft.body"
          :maxlength="131072"
          :rows="6"
          class="w-full mono"
          spellcheck="false"
          autocomplete="off"
        />
      </UFormField>
      <details class="advanced-options">
        <summary>Target headers, proxy, cookies and advanced options</summary>
        <div class="form-stack pt-4">
          <UCheckbox v-model="reveal" label="Show target credentials and advanced JSON" />
          <p class="text-xs muted">
            These fields can contain credentials. They are never added to automatic request history. The instance API
            key is handled separately.
          </p>
          <template v-if="reveal">
            <UFormField label="Target headers (JSON)" description="A map of header names to string values."
              ><UTextarea
                v-model="draft.headers"
                :maxlength="32768"
                :rows="4"
                class="w-full mono"
                autocomplete="off"
                spellcheck="false"
              /></UFormField
            >
            <UFormField
              label="Advanced native options (JSON)"
              description="For example proxy, cookies, waitForSelector, screenshotFullPage, captureResponses or followMetaRefresh. Validation is also applied by the server."
              ><UTextarea
                v-model="draft.options"
                :maxlength="32768"
                :rows="5"
                class="w-full mono"
                autocomplete="off"
                spellcheck="false"
              /></UFormField
            >
          </template>
        </div>
      </details>
      <div class="actions">
        <UButton type="submit" icon="i-lucide-play" :disabled="!native">Send request</UButton>
      </div>
    </fieldset>
  </form>
  <div v-if="pending" class="notice flex items-center justify-between gap-4" role="status">
    <span>Waiting for this request…</span
    ><UButton color="neutral" variant="outline" @click="stop">Stop waiting</UButton>
  </div>
  <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  <details v-if="failureDetails" class="panel panel-body">
    <summary>Failure diagnostics</summary>
    <pre class="failure-diagnostics mono">{{ failureDetails }}</pre>
    <p class="text-xs muted">Diagnostics preview limited to 128 KiB characters</p>
  </details>
  <p v-if="state === 'stopped'" class="notice" role="status">
    Stopped waiting locally. The server or target may still finish work already accepted. Check request history before
    sending again.
  </p>
  <p v-if="requestId && !result" class="mono text-xs break-all">
    {{ requestIdConfirmed ? "Request ID" : "Proposed request ID" }}: {{ requestId }}
    <UButton v-if="historyAvailable" color="neutral" variant="link" @click="emit('history', requestId)"
      >Request history</UButton
    >
  </p>
  <p v-if="requestId && !requestIdConfirmed" class="text-xs muted">
    The server has not confirmed this ID yet. A busy server may replace it, so missing history does not prove that the
    request stopped.
  </p>
  <WorkbenchResponse v-if="result" :result="result" :elapsed="elapsed" @history="emit('history', $event)" />
  <p class="text-xs muted">
    Requests are sent only when you press Send. No automatic retries. Up to 1 MiB input and 8 MiB response; leaving this
    page stops waiting and clears the response. Drafts survive navigation for up to four instances and are cleared when
    the app window closes.
  </p>
</template>
<style scoped>
.failure-diagnostics {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 400px;
  overflow: auto;
  font-size: 12px;
}
.target-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 16px;
}
.options-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.advanced-options > summary {
  cursor: pointer;
  font-size: 14px;
}
fieldset {
  margin: 0;
  border: 0;
  min-width: 0;
}
@media (max-width: 720px) {
  .target-row,
  .options-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
