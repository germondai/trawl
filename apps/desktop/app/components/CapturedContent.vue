<script setup lang="ts">
import type { CapturedMarkdown } from "@trawl/client"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import { capturedDocument } from "~/utils/captured-document"
import { validateJpegPreview } from "~/utils/jpeg-preview"
import { formatLocale, LocalizedError, t } from "~/utils/localization"

const props = defineProps<{ requestId: string; requestAt: string }>()
const reference = () => ({ id: props.requestId, at: props.requestAt })
const { manifest, error } = useSavedCaptures(reference)
const desktop = useDesktopStore()
const visible = useDocumentVisibility()
const view = shallowRef("html")
useNavigationSelection("capture-view", view, { transient: true })
const responses = computed(() => manifest.value?.artifacts.filter((item) => item.kind !== "request") ?? [])
const ready = computed(() => responses.value.filter((item) => item.state === "ready"))
const html = computed(() => ready.value.find((item) => item.kind === "html"))
const htmlContent = computed(() => /^text\/html(?:;|$)/i.test(html.value?.contentType ?? ""))
const views = computed(() => [
  ...(html.value
    ? [
        ...(htmlContent.value ? [{ value: "html", label: "HTML" }] : []),
        ...(htmlContent.value && desktop.capabilities?.captureMarkdown
          ? [{ value: "markdown", label: "Markdown" }]
          : []),
        { value: "raw", label: t("ui.raw") },
      ]
    : []),
  ...(ready.value.some((item) => item.kind === "screenshot")
    ? [{ value: "screenshot", label: t("ui.screenshot") }]
    : []),
])
watch(
  views,
  (items) => {
    if (items.length && !items.some((item) => item.value === view.value)) view.value = items[0]?.value ?? "html"
  },
  { immediate: true },
)
const selected = computed(() =>
  view.value === "screenshot" ? ready.value.find((item) => item.kind === "screenshot") : html.value,
)
const {
  bytes,
  loading: downloading,
  error: downloadError,
  retry,
} = useCaptureArtifact(reference, () => (view.value === "markdown" ? undefined : selected.value))
const markdown = shallowRef<CapturedMarkdown>()
const markdownLoading = shallowRef(false)
const markdownError = useErrorMessage()
const markdownRevision = shallowRef(0)
watch(
  [
    () => `${desktop.activeId}:${props.requestId}:${props.requestAt}:${html.value?.sha256}`,
    view,
    visible,
    markdownRevision,
  ],
  async (_, __, onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    markdown.value = undefined
    markdownError.value = ""
    markdownLoading.value = false
    if (
      view.value !== "markdown" ||
      visible.value !== "visible" ||
      !html.value ||
      !desktop.capabilities?.captureMarkdown
    )
      return
    markdownLoading.value = true
    try {
      const value = await desktop.client().requests.markdown(props.requestId, { signal: controller.signal })
      if (!controller.signal.aborted) markdown.value = value
    } catch (cause) {
      if (!controller.signal.aborted)
        markdownError.value =
          cause instanceof Error || typeof cause === "string"
            ? cause
            : new LocalizedError("ui.savedContentIsUnavailable")
    } finally {
      if (!controller.signal.aborted) markdownLoading.value = false
    }
  },
  { immediate: true },
)
const url = shallowRef("")
const previewError = useErrorMessage()
const limited = shallowRef(false)
const isHTML = computed(
  () => selected.value?.kind === "html" && /^text\/html(?:;|$)/i.test(selected.value.contentType ?? ""),
)
const source = computed(() =>
  bytes.value && selected.value?.kind === "html" ? new TextDecoder().decode(bytes.value) : "",
)
const displayed = computed(() => source.value.slice(0, 128 * 1024))
const size = (value?: number) =>
  value === undefined
    ? ""
    : value < 1024
      ? `${value} B`
      : `${(value / 1024).toLocaleString(formatLocale(), { maximumFractionDigits: 1 })} KiB`
const labels = {
  get pending() {
    return t("ui.saving")
  },
  get ready() {
    return t("ui.saved")
  },
  get unavailable() {
    return t("ui.unavailable")
  },
  get "too-large"() {
    return t("ui.sizeLimitExceeded")
  },
  get expired() {
    return t("ui.expired")
  },
  get failed() {
    return t("ui.failed")
  },
}
watch(
  [bytes, selected, view],
  ([value, artifact, mode], _, onCleanup) => {
    url.value = ""
    previewError.value = ""
    limited.value = false
    if (!value || !artifact || !["html", "screenshot"].includes(mode)) return
    try {
      let blob: Blob
      if (artifact.kind === "screenshot") {
        validateJpegPreview(value)
        blob = new Blob([new Uint8Array(value).buffer], { type: "image/jpeg" })
      } else {
        if (!isHTML.value) return
        const preview = capturedDocument(source.value)
        limited.value = preview.limited
        blob = new Blob([preview.html], { type: "text/html;charset=utf-8" })
      }
      const address = URL.createObjectURL(blob)
      url.value = address
      onCleanup(() => URL.revokeObjectURL(address))
    } catch (cause) {
      previewError.value =
        cause instanceof Error || typeof cause === "string" ? cause : new LocalizedError("ui.previewIsUnavailable")
    }
  },
  { immediate: true },
)
</script>
<template>
  <section class="saved-content form-stack" :aria-label="t('ui.savedResponseContent')">
    <p v-if="error" class="notice" role="status">{{ error }}</p>
    <p v-else-if="!manifest" class="muted" role="status">{{ t("ui.loadingSavedContentMetadata") }}</p>
    <p v-else-if="!responses.length" class="text-xs muted">
      {{ t("ui.contentWasNotSavedConfigure") }}
      <SettingLink name="HISTORY_CAPTURE_MODE">{{ t("ui.responseCapture") }}</SettingLink>
      {{ t("ui.toSaveFutureResponses") }}
    </p>
    <template v-else>
      <div class="flex flex-wrap gap-x-6 gap-y-2 text-xs muted">
        <AppTooltip v-for="artifact in responses" :key="artifact.kind" :text="artifact.reason"
          ><span>
            {{ artifact.kind === "html" ? "HTML" : t("ui.screenshot") }}
            · {{ labels[artifact.state]
            }}<template v-if="artifact.bytes !== undefined"> · {{ size(artifact.bytes) }}</template>
          </span></AppTooltip
        >
      </div>
      <template v-if="selected">
        <fieldset class="capture-tabs flex flex-wrap gap-2" :aria-label="t('ui.savedContentView')">
          <UButton
            v-for="item in views"
            :key="item.value"
            color="neutral"
            :variant="view === item.value ? 'soft' : 'ghost'"
            :aria-pressed="view === item.value"
            @click="view = item.value"
            >{{
              item.label
            }}</UButton
          >
        </fieldset>
        <template v-if="view === 'markdown'">
          <p v-if="markdownLoading" class="muted" role="status">{{ t("preview.loadingResponse") }}</p>
          <div v-else-if="markdownError" class="form-stack">
            <p class="notice" role="status">{{ markdownError }}</p>
            <UButton class="self-start" color="neutral" variant="outline" @click="markdownRevision++">{{
              t("ui.retry")
            }}</UButton>
          </div>
          <AppCodeBlock v-else-if="markdown" :code="markdown.text || t('ui.emptySavedResponse')" language="Markdown" />
          <p v-if="markdown?.truncated" class="text-xs muted">
            {{ t("ui.previewLimitedForResponsivenessSavedContentIsUnchanged") }}
          </p>
        </template>
        <p v-else-if="downloading" class="muted" role="status">
          {{ t(selected.kind === "html" ? "preview.loadingResponse" : "preview.loadingScreenshot") }}
        </p>
        <div v-else-if="downloadError" class="form-stack">
          <p class="notice" role="status">{{ downloadError }}</p>
          <UButton color="neutral" variant="outline" class="self-start" @click="retry">{{
            t("ui.retryDownload")
          }}</UButton>
        </div>
        <p v-else-if="previewError" class="notice" role="status">{{ previewError }}</p>
        <template v-else-if="bytes">
          <img
            v-if="selected.kind === 'screenshot' && url"
            :src="url"
            :alt="t('ui.screenshotSavedWithThisRequest')"
            class="saved-image"
          />
          <iframe
            v-else-if="isHTML && view === 'html' && url"
            :src="url"
            :title="t('ui.readableSavedResponseWithScriptsAndExternalResources')"
            sandbox=""
            referrerpolicy="no-referrer"
            class="saved-document"
          />
          <AppCodeBlock
            v-else
            :code="displayed || t('ui.emptySavedResponse')"
            :language="isHTML ? 'HTML' : selected.contentType"
          />
          <p
            v-if="
              limited || (selected.kind === 'html' && (view === 'raw' || !isHTML) && source.length > displayed.length)
            "
            class="text-xs muted"
          >
            {{ t("ui.previewLimitedForResponsivenessSavedContentIsUnchanged") }}
          </p>
        </template>
        <p v-if="selected.capturedAt" class="text-xs muted">
          {{ t("ui.saved") }} {{ new Date(selected.capturedAt).toLocaleString(formatLocale(), { timeZoneName: "short" })
          }}<template v-if="selected.storedBytes !== undefined">
            · {{ size(selected.storedBytes) }} {{ t("ui.onDisk") }}</template
          ><template v-if="selected.truncated"> {{ t("ui.partialResponse") }}</template>
        </p>
      </template>
      <p class="text-xs muted">
        {{ t("ui.openingThisContentDoesNotContactTheTarget") }}
      </p>
    </template>
  </section>
</template>
<style scoped>
.saved-content {
  padding-top: 0;
  margin-top: 0;
}
.capture-tabs {
  border: 0;
  padding: 0;
  margin: 0;
}
.saved-image {
  max-width: 100%;
  max-height: 720px;
  object-fit: contain;
  object-position: top left;
}
.saved-document {
  width: 100%;
  height: min(60vh, 640px);
  min-height: 240px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: #171719;
}
</style>
