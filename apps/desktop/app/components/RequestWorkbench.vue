<script setup lang="ts">
import { confirmationContent, useNavigationModal, useNavigationSelection } from "~/composables/useNavigationSteps"
import { useWorkbenchRun } from "~/composables/useWorkbenchRun"
import { useDesktopStore } from "~/stores/desktop"
import { useWorkbenchStore } from "~/stores/workbench"
import { formatLocale, LocalizedError, nativeErrorMessage, t } from "~/utils/localization"
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
const tabDrag = useRequestTabDrag(workbench.moveTab)
const { dragging, offset } = tabDrag
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
const tabLabel = (url: string, number: number) => {
  try {
    return new URL(url).hostname
  } catch {
    return t("ui.request2", { p0: number })
  }
}
const native = computed(() => desktop.native)
const historyAvailable = computed(() => Boolean(desktop.capabilities?.requests))
const { sessions, error: sessionError } = useSessions()
const reveal = shallowRef(false)
const editorTab = shallowRef("params")
useNavigationSelection("request-editor", editorTab)
const fieldErrors = ref<Record<string, unknown>>({})
const bodyError = computed(() => nativeErrorMessage(fieldErrors.value.body))
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
  {
    get label() {
      return t("ui.params")
    },
    value: "params",
  },
  {
    get label() {
      return t("ui.headers")
    },
    value: "headers",
  },
  {
    get label() {
      return t("ui.auth")
    },
    value: "auth",
  },
  {
    get label() {
      return t("ui.body")
    },
    value: "body",
  },
  {
    get label() {
      return t("ui.session")
    },
    value: "session",
  },
  {
    get label() {
      return t("ui.options")
    },
    value: "options",
  },
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
  fieldErrors.value.body = new LocalizedError("ui.readingFile")
  try {
    const selected = await readRequestFile(file)
    if (generation !== binaryGeneration || current !== draft.value || draft.value.bodyMode !== "binary") return
    draft.value.body = selected.data
    draft.value.binaryName = selected.name
    fieldErrors.value.body = ""
  } catch (cause) {
    if (generation === binaryGeneration && current === draft.value && draft.value.bodyMode === "binary")
      fieldErrors.value.body = cause instanceof Error ? cause : new LocalizedError("ui.unableToReadFile")
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
  <TransitionGroup
    tag="div"
    name="request-tab"
    move-class="request-tab-move"
    class="request-tabs"
    role="tablist"
    :aria-label="t('ui.requestDrafts')"
  >
    <div
      v-for="(tab, index) in workbench.tabs"
      :key="tab.id"
      class="request-tab"
      :class="{ active: tab.id === workbench.activeTabId, dragging: dragging === tab.id }"
      :style="dragging === tab.id ? { translate: `${offset}px 0` } : undefined"
      @pointerdown="tabDrag.start($event, tab.id)"
      @pointermove="tabDrag.motion"
      @touchmove="tabDrag.touch"
      @pointerup="tabDrag.end"
      @pointercancel="tabDrag.cancel"
      @click.capture="tabDrag.click"
      @keydown.esc="tabDrag.cancel"
      @contextmenu.prevent
    >
      <UButton
        role="tab"
        :aria-selected="tab.id === workbench.activeTabId"
        variant="ghost"
        color="neutral"
        :label="tabLabel(tab.draft.url, tab.number ?? index + 1)"
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        @keydown.alt.left.prevent.stop="workbench.moveTab(tab.id, Math.max(0, index - 1))"
        @keydown.alt.right.prevent.stop="workbench.moveTab(tab.id, Math.min(workbench.tabs.length - 1, index + 1))"
        @click="workbench.activeTabId = tab.id"
      />
      <UButton
        icon="i-lucide-x"
        variant="ghost"
        color="neutral"
        size="xs"
        :aria-label="t('ui.close', { p0: tabLabel(tab.draft.url, tab.number ?? index + 1) })"
        @click="requestDiscard(tab.id, true)"
      />
    </div>
    <UButton
      key="add"
      icon="i-lucide-plus"
      variant="ghost"
      color="neutral"
      :aria-label="t('ui.addRequestTab')"
      :disabled="workbench.tabs.length >= 8"
      @click="workbench.addTab()"
    />
  </TransitionGroup>
  <form class="panel" @submit.prevent="sendRequest">
    <div class="panel-heading request-heading">
      <h2>{{ t("ui.newRequest") }}</h2>
      <div class="actions">
        <UPopover>
          <AppTooltip :text="t('ui.requestBehavior')"
            ><UButton
              icon="i-lucide-info"
              color="neutral"
              variant="ghost"
              :aria-label="t('ui.requestBehavior')"
            /></AppTooltip
          >
          <template #content
            ><div class="request-help">
              {{ t("ui.requestsAreSentOnlyWhenYouPressSend") }}
            </div></template
          >
        </UPopover>
        <AppTooltip :text="t('ui.resetRequest')">
          <UButton
            icon="i-lucide-rotate-cw"
            color="neutral"
            variant="ghost"
            :aria-label="t('ui.resetRequest')"
            :disabled="pending"
            @click="requestDiscard(workbench.activeTabId)"
            ><span class="request-reset-label">{{ t("ui.resetRequest") }}</span></UButton
          >
        </AppTooltip>
      </div>
    </div>
    <fieldset class="panel-body form-stack" :disabled="pending">
      <div class="target-row" data-tour="request-target">
        <UFormField :label="t('ui.targetMethod')"
          ><USelect v-model="draft.method" :items="[...targetMethods]" /></UFormField
        >
        <UFormField :label="t('ui.targetUrl')" required class="min-w-0"
          ><UInput
            data-type-focus
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
        <UButton type="submit" icon="i-lucide-play" :disabled="!native || Object.values(fieldErrors).some(Boolean)">{{
          t("ui.send")
        }}</UButton>
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
          :label="t('ui.queryParameters')"
          format="query"
          :disabled="!validURL"
          @invalid="fieldErrors.params = $event"
        />
        <p v-if="!validURL" class="text-xs muted">{{ t("ui.enterATargetUrlToEditItsParameters") }}</p>
      </div>
      <div v-if="editorTab === 'headers'" class="form-stack">
        <RequestFields
          v-model="draft.headers"
          v-model:rows="draft.fields.headers"
          :label="t('ui.targetHeaders')"
          format="headers"
          @invalid="fieldErrors.headers = $event"
        />
      </div>
      <div v-if="editorTab === 'body'" class="form-stack">
        <URadioGroup
          v-model="bodyKind"
          orientation="horizontal"
          :aria-label="t('ui.bodyType')"
          :items="[
            { label: t('ui.noBody'), value: 'none' },
            { label: t('ui.formData'), value: 'form' },
            { label: t('ui.xWwwFormUrlencoded'), value: 'urlencoded' },
            { label: t('ui.raw'), value: 'raw' },
            { label: t('ui.binary'), value: 'binary' },
            { label: t('ui.graphql'), value: 'graphql' },
          ]"
        />
        <RequestFields
          v-if="draft.bodyMode === 'urlencoded' || draft.bodyMode === 'form'"
          :key="draft.bodyMode"
          v-model="draft.body"
          v-model:rows="draft.fields.body"
          :label="t('ui.bodyFields')"
          format="query"
          :allow-files="draft.bodyMode === 'form'"
          @invalid="fieldErrors.body = $event"
        />
        <UFormField
          v-if="bodyKind === 'binary'"
          :label="t('ui.binaryBody')"
          :description="t('ui.chooseAFileUpTo128KibContent')"
        >
          <UFileUpload
            :model-value="draft.binaryName ? { name: draft.binaryName } : null"
            :label="t('ui.chooseAFileOrDropItHere')"
            :description="t('ui.upTo128Kib')"
            icon="i-lucide-upload"
            :file-image="false"
            :disabled="pending"
            class="w-full"
            :aria-label="t('ui.binaryBodyFile')"
            @update:model-value="chooseBinary"
          />
          <p v-if="fieldErrors.body" class="text-error text-sm" role="alert">{{ bodyError }}</p>
        </UFormField>
        <UFormField v-if="bodyKind === 'raw'" :label="t('ui.contentType')"
          ><USelect
            v-model="rawFormat"
            :items="[
              { label: 'JSON', value: 'json' },
              { label: t('ui.plainText'), value: 'text/plain; charset=utf-8' },
              { label: 'HTML', value: 'text/html; charset=utf-8' },
              { label: 'XML', value: 'application/xml' },
              { label: t('ui.javascript'), value: 'application/javascript' },
            ]"
          /></UFormField
        >
        <UFormField
          v-if="bodyKind === 'raw' || bodyKind === 'graphql'"
          :label="bodyKind === 'graphql' ? t('ui.graphqlQuery') : t('ui.targetRequestBody')"
          :description="
            draft.bodyMode === 'graphql'
              ? t('ui.theQueryAndVariablesAreSentAsA')
              : draft.bodyMode === 'json'
                ? t('ui.jsonIsSerializedAndContentTypeIsSet')
                : t('ui.contentTypeOverrideItInTargetHeadersIf', { p0: draft.bodyContentType })
          "
        >
          <UTextarea
            v-model="draft.body"
            :placeholder="
              draft.bodyMode === 'graphql'
                ? 'query { viewer { id name } }'
                : draft.bodyMode === 'json'
                  ? '{\n  &quot;name&quot;: &quot;value&quot;\n}'
                  : t('request.bodyPlaceholder')
            "
            :maxlength="131072"
            :rows="6"
            class="w-full mono"
            spellcheck="false"
            autocomplete="off"
          />
        </UFormField>
        <UFormField v-if="bodyKind === 'graphql'" :label="t('ui.variablesJson')"
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
        <UFormField :label="t('ui.authType')"
          ><USelect
            v-model="draft.auth.type"
            :items="[
              { label: t('ui.noAuth'), value: 'none' },
              { label: t('ui.basicAuth'), value: 'basic' },
              { label: t('ui.bearerToken'), value: 'bearer' },
              { label: t('ui.apiKey'), value: 'api-key' },
            ]"
          /></UFormField
        >
        <template v-if="draft.auth.type === 'basic'">
          <UFormField :label="t('ui.username')"
            ><UInput
              v-model="draft.auth.username"
              :placeholder="t('ui.username')"
              :maxlength="8192"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
          <UFormField :label="t('ui.password')"
            ><UInput
              v-model="draft.auth.password"
              :placeholder="t('ui.password')"
              type="password"
              :maxlength="8192"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
        </template>
        <UFormField v-if="draft.auth.type === 'bearer'" :label="t('ui.bearerToken2')"
          ><UInput
            v-model="draft.auth.token"
            :placeholder="t('ui.tokenWithoutBearerPrefix')"
            type="password"
            :maxlength="8192"
            autocomplete="off"
            class="w-full"
          /></UFormField
        >
        <template v-if="draft.auth.type === 'api-key'">
          <UFormField :label="t('ui.keyName')"
            ><UInput
              v-model="draft.auth.name"
              :placeholder="t('ui.xApiKey')"
              :maxlength="256"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
          <UFormField :label="t('ui.keyValue')"
            ><UInput
              v-model="draft.auth.value"
              :placeholder="t('ui.apiKey2')"
              type="password"
              :maxlength="8192"
              autocomplete="off"
              class="w-full"
            /></UFormField
          >
          <UFormField :label="t('ui.addKeyTo')"
            ><USelect
              v-model="draft.auth.in"
              :items="[
                { label: t('ui.header'), value: 'header' },
                { label: t('ui.queryParameter'), value: 'query' },
              ]"
            /></UFormField
          >
        </template>
        <p class="text-xs muted">
          {{ t("ui.theseCredentialsAuthenticateTheTargetSeparatelyFromYour") }}
        </p>
      </div>
      <div v-if="editorTab === 'session'" class="form-stack">
        <p v-if="authenticated" class="text-xs muted">
          {{ t("ui.targetAuthRequiresAnEmptySessionIdChoose") }}
        </p>
        <div class="session-fields">
          <UFormField :label="t('ui.sessionId')">
            <UInput
              v-model="draft.sessionId"
              :maxlength="128"
              :placeholder="t('ui.optionalSessionId')"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('ui.availableSessions')"
            ><USelect
              v-model="draft.sessionId"
              :items="sessionItems"
              :placeholder="t('ui.selectAnActiveSession')"
              class="w-full"
            /></UFormField
          >
        </div>
        <p class="text-xs muted">
          {{ t("ui.reuseASessionFromTheListOrEnter") }}
        </p>
        <p v-if="sessionError" class="notice error" role="alert">{{ sessionError }}</p>
      </div>
      <div v-if="editorTab === 'options'" class="form-stack">
        <div class="options-row">
          <UFormField :label="t('ui.output')"
            ><USelect v-model="draft.output" :items="outputItems" class="w-full" /></UFormField
          >
          <UFormField :label="t('ui.timeoutSeconds')"
            ><UInput
              v-model.number="draft.timeout"
              type="number"
              :min="1"
              :max="180"
              required
              class="w-full"
            /></UFormField
          >
          <UFormField :label="t('ui.maximumTier')"
            ><USelect
              v-model="effectiveTier"
              :disabled="httpOnly"
              class="w-full"
              :items="[
                { label: t('ui.allTiers4'), value: 4 },
                { label: t('ui.upToTier3'), value: 3 },
                { label: t('ui.upToTier2'), value: 2 },
                { label: t('ui.httpOnly1'), value: 1 },
              ]"
            /></UFormField
          >
        </div>
        <div v-if="draft.output === 'extract'">
          <UFormField
            :label="t('ui.extractionOptionsJson')"
            :description="t('ui.cssItemselectorFieldsWithSelectorAttributeAndOptional')"
          >
            <UTextarea v-model="draft.extraction" :maxlength="32768" :rows="7" class="w-full mono" spellcheck="false" />
          </UFormField>
        </div>

        <UCheckbox v-model="reveal" :label="t('ui.showAdvancedOptionsAndCredentials')" />
        <template v-if="reveal">
          <UFormField
            :label="t('ui.advancedNativeOptionsJson')"
            :description="t('ui.forExampleProxyCookiesWaitforselectorScreenshotfullpageOrFollowmetarefresh')"
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
    <span class="request-running"
      ><UIcon name="i-lucide-rotate-cw" class="size-4 animate-spin motion-reduce:animate-none" />
      <span
        >{{ t("ui.waitingForThisRequest") }}
        <span class="mono" aria-hidden="true"
          >{{ (elapsed / 1000).toLocaleString(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}
          s</span
        ></span
      ></span
    ><UButton color="neutral" variant="outline" @click="stop">{{ t("ui.stopWaiting") }}</UButton>
  </div>
  <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  <details v-if="failureDetails" class="panel panel-body">
    <summary>{{ t("ui.failureDiagnostics") }}</summary>
    <pre class="failure-diagnostics mono">{{ failureDetails }}</pre>
    <p class="text-xs muted">{{ t("ui.diagnosticsPreviewLimitedTo128KibCharacters") }}</p>
  </details>
  <p v-if="state === 'stopped'" class="notice" role="status">
    {{ t("ui.stoppedWaitingLocallyTheServerOrTargetMay") }}
  </p>
  <p v-if="requestId && !result" class="mono text-xs break-all">
    {{ requestIdConfirmed ? t("ui.requestId") : t("ui.proposedRequestId") }}: {{ requestId }}
    <UButton v-if="historyAvailable" color="neutral" variant="link" @click="emit('history', requestId)">{{
      t("ui.requestHistory")
    }}</UButton>
  </p>
  <p v-if="requestId && !requestIdConfirmed" class="text-xs muted">
    {{ t("ui.theServerHasNotConfirmedThisIdYet") }}
  </p>
  <WorkbenchResponse v-if="result" :result="result" :elapsed="elapsed" @history="emit('history', $event)" />
  <AppDialog
    :open="Boolean(discard)"
    :content="confirmationContent"
    :title="t('ui.discardThisRequestDraft')"
    :description="t('ui.theRequestFieldsWillBeClearedSavedServer')"
    @update:open="if (!$event) discard = undefined;"
  >
    <template #footer
      ><UButton color="neutral" variant="outline" @click="discard = undefined">{{ t("ui.keepDraft") }}</UButton
      ><UButton data-confirm-default @click="discard && applyDiscard(discard.id, discard.close)">{{
        t("ui.discardDraft")
      }}</UButton></template
    >
  </AppDialog>
</template>
<style scoped>
.request-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  padding: 4px;
  margin: -4px -4px 12px;
  position: relative;
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
  background: var(--ui-bg);
}
.request-tab:hover {
  background: var(--ui-bg-elevated);
}
.request-tab:focus-within,
.request-tab.dragging {
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
