<script setup lang="ts">
import { confirmationContent, useNavigationModal, useNavigationSelection } from "~/composables/useNavigationSteps"
import { useWorkbenchRun } from "~/composables/useWorkbenchRun"
import { useDesktopStore } from "~/stores/desktop"
import { useWorkbenchStore } from "~/stores/workbench"
import { readRequestFile } from "~/utils/request-body"
import { serializeRequestFields } from "~/utils/request-fields"
import {
  httpOnlyWorkbench,
  newWorkbenchDraft,
  replacesWorkbenchDraft,
  targetMethods,
  workbenchOutputs,
} from "~/utils/workbench"

const emit = defineEmits<{ history: [id: string] }>()
const desktop = useDesktopStore()
const workbench = useWorkbenchStore()
const { draft } = storeToRefs(workbench)
const { state, error, failureDetails, result, requestId, requestIdConfirmed, elapsed, send, stop, reset } =
  useWorkbenchRun()
const discard = shallowRef<{ id: string; close: boolean }>()
useNavigationModal(discard, undefined)
const navigation = useNavigationSelection("workbench-tab", toRef(workbench, "activeTabId"), {
  valid: (id) => workbench.tabs.some((tab) => tab.id === id),
})
function requestDiscard(id: string, close = false) {
  const input = workbench.tabs.find((tab) => tab.id === id)?.draft
  if (input && replacesWorkbenchDraft(input, newWorkbenchDraft())) discard.value = { id, close }
  else applyDiscard(id, close)
}
function applyDiscard(id: string, close: boolean) {
  discard.value = undefined
  if (id === workbench.activeTabId) reset()
  if (close) {
    workbench.closeTab(id)
    if (!workbench.tabs.some((tab) => tab.id === id))
      navigation?.dropSelection("workbench-tab", id, workbench.activeTabId)
  } else draft.value = newWorkbenchDraft()
}
watch(
  () => workbench.activeTabId,
  () => {
    reset()
    reveal.value = false
  },
)
const tabLabel = (url: string, index: number) => {
  try {
    return new URL(url).hostname
  } catch {
    return `Request ${index + 1}`
  }
}
const native = computed(() => desktop.native)
const historyAvailable = computed(() => Boolean(desktop.capabilities?.requests))
const { sessions, error: sessionError } = useSessions()
const reveal = shallowRef(false)
const editorTab = shallowRef("params")
useNavigationSelection("request-editor", editorTab)
const fieldErrors = ref<Record<string, string>>({})
let binaryGeneration = 0
onScopeDispose(() => {
  binaryGeneration++
})
watch(draft, () => {
  binaryGeneration++
  fieldErrors.value = {}
})
watch(
  () => draft.value.bodyMode,
  () => {
    binaryGeneration++
    fieldErrors.value.body = ""
  },
  { flush: "sync" },
)
const editorTabs = [
  { label: "Params", value: "params" },
  { label: "Headers", value: "headers" },
  { label: "Auth", value: "auth" },
  { label: "Body", value: "body" },
  { label: "Session", value: "session" },
  { label: "Options", value: "options" },
]
const queryText = computed({
  get: () => {
    try {
      return new URL(draft.value.url).searchParams.toString()
    } catch {
      return ""
    }
  },
  set: (value: string) => {
    try {
      const url = new URL(draft.value.url)
      url.search = value.split("\n").filter(Boolean).join("&")
      draft.value.url = url.href
    } catch {}
  },
})
const bodyKind = computed({
  get: () => (["text", "json"].includes(draft.value.bodyMode) ? "raw" : draft.value.bodyMode),
  set: (value: string) => {
    if (draft.value.bodyMode === "form" && value !== "form") {
      draft.value.fields.body = draft.value.fields.body.filter((row) => !row.file)
      draft.value.body = serializeRequestFields(draft.value.fields.body, "query")
    }
    if (value === "binary" || draft.value.bodyMode === "binary") {
      draft.value.body = ""
      draft.value.binaryName = ""
    }
    draft.value.bodyMode = value === "raw" ? "json" : (value as typeof draft.value.bodyMode)
  },
})
const rawFormat = computed({
  get: () => (draft.value.bodyMode === "json" ? "json" : draft.value.bodyContentType),
  set: (value: string) => {
    draft.value.bodyMode = value === "json" ? "json" : "text"
    if (value !== "json") draft.value.bodyContentType = value
  },
})
function sendRequest() {
  return send(draft.value)
}
const validURL = computed(() => {
  try {
    return ["http:", "https:"].includes(new URL(draft.value.url).protocol)
  } catch {
    return false
  }
})
const sessionItems = computed(() => sessions.value.map((session) => ({ label: session.id, value: session.id })))
const pending = computed(() => state.value === "pending")
const authenticated = computed(() => draft.value.auth.type !== "none")
const httpOnly = computed(() => httpOnlyWorkbench(draft.value))
const outputItems = computed(() =>
  workbenchOutputs.map((item) => ({
    ...item,
    disabled: httpOnly.value && ["screenshot", "inspect"].includes(item.value),
  })),
)
const effectiveTier = computed({
  get: () => (httpOnly.value ? 1 : draft.value.maxTier),
  set: (value: 1 | 2 | 3 | 4) => {
    draft.value.maxTier = value
  },
})
async function chooseBinary(file: { name: string } | File | null | undefined) {
  if (!file) {
    binaryGeneration++
    draft.value.body = ""
    draft.value.binaryName = ""
    fieldErrors.value.body = ""
    return
  }
  if (!(file instanceof File)) return
  const current = draft.value
  const generation = ++binaryGeneration
  fieldErrors.value.body = "Reading file…"
  try {
    const selected = await readRequestFile(file)
    if (generation !== binaryGeneration || current !== draft.value || draft.value.bodyMode !== "binary") return
    draft.value.body = selected.data
    draft.value.binaryName = selected.name
    fieldErrors.value.body = ""
  } catch (cause) {
    if (generation === binaryGeneration && current === draft.value && draft.value.bodyMode === "binary")
      fieldErrors.value.body = cause instanceof Error ? cause.message : "Unable to read file"
  }
}
watch(
  () => desktop.activeId,
  () => {
    reveal.value = false
  },
)
</script>
<template>
  <div class="request-tabs" role="tablist" aria-label="Request drafts">
    <div
      v-for="(tab, index) in workbench.tabs"
      :key="tab.id"
      class="request-tab"
      :class="{ active: tab.id === workbench.activeTabId }"
    >
      <UButton
        role="tab"
        :aria-selected="tab.id === workbench.activeTabId"
        variant="ghost"
        color="neutral"
        :label="tabLabel(tab.draft.url, index)"
        @click="workbench.activeTabId = tab.id"
      />
      <UButton
        icon="i-lucide-x"
        variant="ghost"
        color="neutral"
        size="xs"
        :aria-label="`Close ${tabLabel(tab.draft.url, index)}`"
        @click="requestDiscard(tab.id, true)"
      />
    </div>
    <UButton
      icon="i-lucide-plus"
      variant="ghost"
      color="neutral"
      aria-label="Add request tab"
      :disabled="workbench.tabs.length >= 8"
      @click="workbench.addTab()"
    />
  </div>
  <form class="panel" @submit.prevent="sendRequest">
    <div class="panel-heading">
      <h2>New request</h2>
      <div class="actions">
        <UPopover>
          <UTooltip text="Request behavior"
            ><UButton icon="i-lucide-info" color="neutral" variant="ghost" aria-label="Request behavior" /></UTooltip
          >
          <template #content
            ><div class="request-help">
              Requests are sent only when you press Send. No automatic retries. Up to 1 MiB input and 8 MiB response.
              Leaving this page or switching tabs clears the response. Up to eight drafts per instance stay in memory
              for up to four instances, until the app window closes.
            </div></template
          >
        </UPopover>
        <UButton
          icon="i-lucide-rotate-cw"
          color="neutral"
          variant="ghost"
          :disabled="pending"
          @click="requestDiscard(workbench.activeTabId)"
          >Reset request</UButton
        >
      </div>
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
        <UButton type="submit" icon="i-lucide-play" :disabled="!native || Object.values(fieldErrors).some(Boolean)"
          >Send</UButton
        >
      </div>
      <UTabs
        class="inspection-tabs"
        v-model="editorTab"
        :items="editorTabs"
        :content="false"
        variant="link"
        :ui="{ list: 'justify-start', trigger: 'shrink-0' }"
      />
      <div v-if="editorTab === 'params'" class="form-stack">
        <RequestFields
          v-model="queryText"
          v-model:rows="draft.fields.params"
          label="Query parameters"
          format="query"
          :disabled="!validURL"
          @invalid="fieldErrors.params = $event"
        />
        <p v-if="!validURL" class="text-xs muted">Enter a target URL to edit its parameters.</p>
      </div>
      <div v-if="editorTab === 'headers'" class="form-stack">
        <RequestFields
          v-model="draft.headers"
          v-model:rows="draft.fields.headers"
          label="Target headers"
          format="headers"
          @invalid="fieldErrors.headers = $event"
        />
      </div>
      <div v-if="editorTab === 'body'" class="form-stack">
        <URadioGroup
          v-model="bodyKind"
          orientation="horizontal"
          aria-label="Body type"
          :items="[
            { label: 'No body', value: 'none' },
            { label: 'form-data', value: 'form' },
            { label: 'x-www-form-urlencoded', value: 'urlencoded' },
            { label: 'Raw', value: 'raw' },
            { label: 'Binary', value: 'binary' },
            { label: 'GraphQL', value: 'graphql' },
          ]"
        />
        <RequestFields
          v-if="draft.bodyMode === 'urlencoded' || draft.bodyMode === 'form'"
          :key="draft.bodyMode"
          v-model="draft.body"
          v-model:rows="draft.fields.body"
          label="Body fields"
          format="query"
          :allow-files="draft.bodyMode === 'form'"
          @invalid="fieldErrors.body = $event"
        />
        <UFormField
          v-if="bodyKind === 'binary'"
          label="Binary body"
          description="Choose a file up to 128 KiB. Content-Type defaults to application/octet-stream; override it in Headers if needed. Non-POST binary bodies use HTTP only."
        >
          <UFileUpload
            :model-value="draft.binaryName ? { name: draft.binaryName } : null"
            label="Choose a file or drop it here"
            description="Up to 128 KiB"
            icon="i-lucide-upload"
            :file-image="false"
            :disabled="pending"
            class="w-full"
            aria-label="Binary body file"
            @update:model-value="chooseBinary"
          />
          <p v-if="fieldErrors.body" class="text-error text-sm" role="alert">{{ fieldErrors.body }}</p>
        </UFormField>
        <UFormField v-if="bodyKind === 'raw'" label="Content type"
          ><USelect
            v-model="rawFormat"
            :items="[
              { label: 'JSON', value: 'json' },
              { label: 'Plain text', value: 'text/plain; charset=utf-8' },
              { label: 'HTML', value: 'text/html; charset=utf-8' },
              { label: 'XML', value: 'application/xml' },
              { label: 'JavaScript', value: 'application/javascript' },
            ]"
          /></UFormField
        >
        <UFormField
          v-if="bodyKind === 'raw' || bodyKind === 'graphql'"
          :label="bodyKind === 'graphql' ? 'GraphQL query' : 'Target request body'"
          :description="
            draft.bodyMode === 'graphql'
              ? 'The query and variables are sent as a JSON object.'
              : draft.bodyMode === 'json'
                ? 'JSON is serialized and Content-Type is set automatically.'
                : `Content-Type: ${draft.bodyContentType}. Override it in target headers if needed.`
          "
        >
          <UTextarea
            v-model="draft.body"
            :placeholder="
              draft.bodyMode === 'graphql'
                ? 'query { viewer { id name } }'
                : draft.bodyMode === 'json'
                  ? '{\n  &quot;name&quot;: &quot;value&quot;\n}'
                  : 'Enter the target request body'
            "
            :maxlength="131072"
            :rows="6"
            class="w-full mono"
            spellcheck="false"
            autocomplete="off"
          />
        </UFormField>
        <UFormField v-if="bodyKind === 'graphql'" label="Variables (JSON)"
          ><UTextarea
            v-model="draft.graphqlVariables"
            placeholder='{ "id": "123" }'
            :rows="4"
            :maxlength="32768"
            class="w-full mono"
            spellcheck="false"
          /></UFormField
        >
      </div>
      <div v-if="editorTab === 'auth'" class="form-stack">
        <UFormField label="Auth type"
          ><USelect
            v-model="draft.auth.type"
            :items="[
              { label: 'No Auth', value: 'none' },
              { label: 'Basic Auth', value: 'basic' },
              { label: 'Bearer Token', value: 'bearer' },
              { label: 'API Key', value: 'api-key' },
            ]"
          /></UFormField
        >
        <template v-if="draft.auth.type === 'basic'">
          <UFormField label="Username"
            ><UInput
              v-model="draft.auth.username"
              placeholder="Username"
              :maxlength="8192"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
          <UFormField label="Password"
            ><UInput
              v-model="draft.auth.password"
              placeholder="Password"
              type="password"
              :maxlength="8192"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
        </template>
        <UFormField v-if="draft.auth.type === 'bearer'" label="Bearer token"
          ><UInput
            v-model="draft.auth.token"
            placeholder="Token without Bearer prefix"
            type="password"
            :maxlength="8192"
            autocomplete="off"
            class="w-full"
          /></UFormField
        >
        <template v-if="draft.auth.type === 'api-key'">
          <UFormField label="Key name"
            ><UInput
              v-model="draft.auth.name"
              placeholder="X-API-Key"
              :maxlength="256"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
          <UFormField label="Key value"
            ><UInput
              v-model="draft.auth.value"
              placeholder="API key"
              type="password"
              :maxlength="8192"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
          <UFormField label="Add key to"
            ><USelect
              v-model="draft.auth.in"
              :items="[
                { label: 'Header', value: 'header' },
                { label: 'Query parameter', value: 'query' },
              ]"
            /></UFormField
          >
        </template>
        <p class="text-xs muted">
          These credentials authenticate the target, separately from your TRAWL instance key. Target Auth uses HTTP
          only, without browser sessions, imported cookies, screenshots or browser diagnostics. Header credentials are
          removed on cross-origin redirects. Request capture, when enabled on the server, can retain credentials.
        </p>
      </div>
      <div v-if="editorTab === 'session'" class="form-stack">
        <p v-if="authenticated" class="text-xs muted">
          Target Auth requires an empty Session ID. Choose No Auth to use browser sessions.
        </p>
        <div class="session-fields">
          <UFormField label="Session ID">
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
              placeholder="Select an active session"
              class="w-full"
            /></UFormField
          >
        </div>
        <p class="text-xs muted">
          Reuse a session from the list or enter its ID. Manage retained pages and cookies in Sessions.
        </p>
        <p v-if="sessionError" class="notice error" role="alert">{{ sessionError }}</p>
      </div>
      <div v-if="editorTab === 'options'" class="form-stack">
        <div class="options-row">
          <UFormField label="Output"><USelect v-model="draft.output" :items="outputItems" class="w-full" /></UFormField>
          <UFormField label="Timeout (seconds)"
            ><UInput
              v-model.number="draft.timeout"
              type="number"
              :min="1"
              :max="180"
              required
              class="w-full"
            /></UFormField
          >
          <UFormField label="Maximum tier"
            ><USelect
              v-model="effectiveTier"
              :disabled="httpOnly"
              class="w-full"
              :items="[
                { label: 'All tiers (4)', value: 4 },
                { label: 'Up to tier 3', value: 3 },
                { label: 'Up to tier 2', value: 2 },
                { label: 'HTTP only (1)', value: 1 },
              ]"
            /></UFormField
          >
        </div>
        <div v-if="draft.output === 'extract'">
          <UFormField
            label="Extraction options (JSON)"
            description="CSS itemSelector, fields with selector/attribute, and optional maxItems/render."
          >
            <UTextarea v-model="draft.extraction" :maxlength="32768" :rows="7" class="w-full mono" spellcheck="false" />
          </UFormField>
        </div>

        <UCheckbox v-model="reveal" label="Show advanced options and credentials" />
        <template v-if="reveal">
          <UFormField
            label="Advanced native options (JSON)"
            description="For example proxy, cookies, waitForSelector, screenshotFullPage or followMetaRefresh; maxCharacters limits read output. Validation is also applied by the server."
            ><UTextarea
              v-model="draft.options"
              placeholder='{ "waitForSelector": "#results" }'
              :maxlength="32768"
              :rows="5"
              class="w-full mono"
              autocomplete="off"
              spellcheck="false"
            /></UFormField
          >
        </template>
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
  <UModal
    :open="Boolean(discard)"
    :content="confirmationContent"
    title="Discard this request draft?"
    description="The request fields will be cleared. Saved server history is kept."
    @update:open="if (!$event) discard = undefined;"
  >
    <template #footer
      ><UButton color="neutral" variant="outline" @click="discard = undefined">Keep draft</UButton
      ><UButton data-confirm-default @click="discard && applyDiscard(discard.id, discard.close)"
        >Discard draft</UButton
      ></template
    >
  </UModal>
</template>
<style scoped>
.request-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  margin-bottom: 16px;
}
.request-tab {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  padding: 0 4px 0 0;
  gap: 0;
  overflow: hidden;
}
.request-tab:hover {
  background: var(--ui-bg-elevated);
}
.request-tab:focus-within {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.request-tab > button {
  background: transparent;
  outline: none;
  box-shadow: none;
}
.request-tab.active {
  background: var(--ui-bg-elevated);
  border-color: var(--ui-border-accented);
}
.request-tab > button:first-child {
  border-radius: 0;
  min-width: 100px;
  justify-content: flex-start;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.request-help {
  max-width: 340px;
  padding: 16px;
  font-size: 13px;
  line-height: 1.6;
}
.failure-diagnostics {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 400px;
  overflow: auto;
  font-size: 12px;
}
.target-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) auto;
  align-items: end;
  gap: 16px;
}
.options-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.session-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: end;
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
  .session-fields,
  .options-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
