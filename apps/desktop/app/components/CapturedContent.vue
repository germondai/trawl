<script setup lang="ts">
import type { ArtifactKind } from "@trawl/client"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import { capturedDocument } from "~/utils/captured-document"
import { validateJpegPreview } from "~/utils/jpeg-preview"

const props = defineProps<{ requestId: string; requestAt: string; view?: "preview" | "source" }>()
const reference = () => ({ id: props.requestId, at: props.requestAt })
const { manifest, loading, error } = useSavedCaptures(reference)
const preference = useLocalStorage<ArtifactKind>("trawl.capture.preview", "screenshot", { onError: () => {} })
const responses = computed(() => manifest.value?.artifacts.filter((item) => item.kind !== "request") ?? [])
const ready = computed(() => responses.value.filter((item) => item.state === "ready"))
const selected = computed(() =>
  props.view === "source"
    ? ready.value.find((item) => item.kind === "html")
    : (ready.value.find((item) => item.kind === preference.value) ?? ready.value[0]),
)
const { bytes, loading: downloading, error: downloadError, retry } = useCaptureArtifact(reference, () => selected.value)
const localView = shallowRef<"preview" | "source">("preview")
useNavigationSelection("capture-view", localView, { transient: true })
useNavigationSelection("capture-artifact", preference, { transient: true })
const view = computed(() => props.view ?? localView.value)
const url = shallowRef("")
const previewError = shallowRef("")
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
      : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`
const labels = {
  pending: "Saving",
  ready: "Saved",
  unavailable: "Unavailable",
  "too-large": "Size limit exceeded",
  expired: "Expired",
  failed: "Failed",
}
watch(
  [bytes, selected, view],
  ([value, artifact, mode], _, onCleanup) => {
    url.value = ""
    previewError.value = ""
    limited.value = false
    if (!value || !artifact || mode === "source") return
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
      previewError.value = cause instanceof Error ? cause.message : "Preview is unavailable"
    }
  },
  { immediate: true },
)
</script>
<template>
  <section class="saved-content form-stack" aria-label="Saved response content">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <h3>Saved response</h3>
    </div>
    <p v-if="error" class="notice" role="status">{{ error }}</p>
    <p v-else-if="!manifest" class="muted" role="status">Loading saved-content metadata…</p>
    <p v-else-if="!responses.length" class="text-xs muted">
      Content was not saved. Configure <SettingLink name="HISTORY_CAPTURE_MODE">response capture</SettingLink> to save
      future responses.
    </p>
    <template v-else>
      <div class="flex flex-wrap gap-x-6 gap-y-2 text-xs muted">
        <UTooltip v-for="artifact in responses" :key="artifact.kind" :text="artifact.reason"
          ><span>
            {{ artifact.kind === "html" ? "HTML" : "Screenshot" }}
            · {{ labels[artifact.state]
            }}<template v-if="artifact.bytes !== undefined"> · {{ size(artifact.bytes) }}</template>
          </span></UTooltip
        >
      </div>
      <template v-if="selected">
        <fieldset
          v-if="props.view !== 'source'"
          class="capture-tabs flex flex-wrap gap-2"
          aria-label="Saved-content view"
        >
          <UButton
            v-for="artifact in ready"
            :key="artifact.kind"
            color="neutral"
            :variant="selected.kind === artifact.kind ? 'soft' : 'ghost'"
            :aria-pressed="selected.kind === artifact.kind"
            @click="
              preference = artifact.kind;
              localView = 'preview';
            "
            >{{
              artifact.kind === "html" ? "HTML" : "Screenshot"
            }}</UButton
          >
          <UButton
            v-if="!props.view && selected.kind === 'html' && isHTML"
            color="neutral"
            :variant="view === 'source' ? 'soft' : 'ghost'"
            :aria-pressed="view === 'source'"
            @click="localView = view === 'source' ? 'preview' : 'source'"
            >Source</UButton
          >
        </fieldset>
        <p v-if="downloading" class="muted" role="status">
          Loading saved {{ selected.kind === "html" ? "response" : "screenshot" }}…
        </p>
        <div v-else-if="downloadError" class="form-stack">
          <p class="notice" role="status">{{ downloadError }}</p>
          <UButton color="neutral" variant="outline" class="self-start" @click="retry">Retry download</UButton>
        </div>
        <p v-else-if="previewError" class="notice" role="status">{{ previewError }}</p>
        <template v-else-if="bytes">
          <img
            v-if="selected.kind === 'screenshot' && url"
            :src="url"
            alt="Screenshot saved with this request"
            class="saved-image"
          />
          <iframe
            v-else-if="isHTML && view === 'preview' && url"
            :src="url"
            title="Readable saved response, with scripts and external resources removed"
            sandbox=""
            referrerpolicy="no-referrer"
            class="saved-document"
          />
          <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll saved source. -->
          <pre v-else class="saved-source mono" tabindex="0">{{ displayed || 'Empty saved response' }}</pre>
          <p
            v-if="
              limited ||
              (selected.kind === 'html' && (view === 'source' || !isHTML) && source.length > displayed.length)
            "
            class="text-xs muted"
          >
            Preview limited for responsiveness. Saved content is unchanged.
          </p>
        </template>
        <p v-if="selected.capturedAt" class="text-xs muted">
          Saved {{ new Date(selected.capturedAt).toLocaleString()
          }}<template v-if="selected.storedBytes !== undefined"> · {{ size(selected.storedBytes) }} on disk</template
          ><template v-if="selected.truncated"> · Partial response</template>
        </p>
      </template>
      <p v-if="!selected && props.view === 'source'" class="text-xs muted">
        No response body was saved. Open Preview to view any retained screenshot.
      </p>
      <p class="text-xs muted">
        Opening this content does not contact the target again. HTML keeps supported page styles in an offline preview
        without scripts, forms or network resources. Screenshots preserve its captured appearance.
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
.saved-source {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 480px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
}
</style>
