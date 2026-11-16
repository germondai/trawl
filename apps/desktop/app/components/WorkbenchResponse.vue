<script setup lang="ts">
import { jpegPreviewBytes } from "~/utils/jpeg-preview"
import { jsonPreview } from "~/utils/json-preview"
import { type WorkbenchResult, workbenchText } from "~/utils/workbench"

const props = defineProps<{ result: WorkbenchResult; elapsed: number }>()
const desktop = useDesktopStore()
const emit = defineEmits<{ history: [id: string] }>()
const view = shallowRef<"content" | "json" | "image">("content")
const imageURL = shallowRef("")
const imageError = shallowRef("")
const limit = 128 * 1024
const content = computed(() => workbenchText(props.result))
const displayed = computed(() =>
  (view.value === "json" ? jsonPreview(props.result, limit) : content.value).slice(0, limit),
)
const truncated = computed(() =>
  view.value === "json" ? displayed.value.length >= limit : content.value.length > limit,
)
const hasImage = computed(() => "screenshot" in props.result && Boolean(props.result.screenshot))
watch(
  () => props.result,
  () => {
    view.value = hasImage.value ? "image" : "content"
  },
  { immediate: true },
)
watch(
  [() => props.result, view],
  ([result, mode], _, onCleanup) => {
    imageURL.value = ""
    imageError.value = ""
    if (mode !== "image" || !("screenshot" in result) || !result.screenshot) return
    try {
      const bytes = jpegPreviewBytes(result.screenshot)
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }))
      imageURL.value = url
      onCleanup(() => URL.revokeObjectURL(url))
    } catch (cause) {
      imageError.value = cause instanceof Error ? cause.message : "Image preview unavailable"
    }
  },
  { immediate: true },
)
</script>
<template>
  <section class="panel" aria-label="Workbench response">
    <div class="panel-heading flex-wrap gap-3">
      <h2>Response</h2>
      <span class="status"
        ><span class="dot" :class="{ ready: result.statusCode < 400, failed: result.statusCode >= 400 }" />Target HTTP
        {{ result.statusCode }}</span
      >
    </div>
    <div class="panel-body form-stack">
      <dl class="response-facts">
        <div>
          <dt>Execution</dt>
          <dd>Tier {{ result.tier }}</dd>
        </div>
        <div>
          <dt>Engine time</dt>
          <dd class="mono">{{ result.totalMs.toLocaleString() }} ms</dd>
        </div>
        <div>
          <dt>Total wait</dt>
          <dd class="mono">{{ elapsed.toLocaleString() }} ms</dd>
        </div>
      </dl>
      <div v-if="result.requestId" class="response-id">
        <span class="mono break-all text-xs">{{ result.requestId }}</span>
        <UButton
          v-if="desktop.capabilities?.requests"
          color="neutral"
          variant="link"
          trailing-icon="i-lucide-chevron-right"
          @click="emit('history', result.requestId)"
          >Request history</UButton
        >
      </div>
      <p v-if="result.statusCode >= 400" class="notice">
        The API completed the request, but the target returned HTTP {{ result.statusCode }}.
      </p>
      <fieldset class="actions response-tabs" aria-label="Response view">
        <UButton
          color="neutral"
          :variant="view === 'content' ? 'soft' : 'ghost'"
          :aria-pressed="view === 'content'"
          @click="view = 'content'"
          >Content</UButton
        >
        <UButton
          color="neutral"
          :variant="view === 'json' ? 'soft' : 'ghost'"
          :aria-pressed="view === 'json'"
          @click="view = 'json'"
          >Response JSON</UButton
        >
        <UButton
          v-if="hasImage"
          color="neutral"
          :variant="view === 'image' ? 'soft' : 'ghost'"
          :aria-pressed="view === 'image'"
          @click="view = 'image'"
          >Screenshot</UButton
        >
      </fieldset>
      <template v-if="view === 'image'">
        <p v-if="imageError" class="notice" role="status">{{ imageError }}</p>
        <img v-else-if="imageURL" :src="imageURL" alt="Screenshot captured by this request" class="response-image" />
      </template>
      <template v-else>
        <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll long response content. -->
        <pre class="response-content mono" tabindex="0">{{ displayed || 'Empty response content' }}</pre>
        <p v-if="truncated" class="text-xs muted">
          Preview limited to 128 KiB characters. The response in memory is unchanged.
        </p>
      </template>
      <p class="text-xs muted">
        Response data stays in memory until you leave this page or clear it. HTML is shown as source; it is not
        executed.
      </p>
    </div>
  </section>
</template>
<style scoped>
.response-tabs {
  border: 0;
  padding: 0;
  margin: 0;
}
.response-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 24px 48px;
  margin: 0;
}
.response-facts dt {
  font-size: 12px;
  color: var(--ui-text-muted);
  margin-bottom: 8px;
}
.response-facts dd {
  margin: 0;
}
.response-id {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.response-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 480px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
}
.response-image {
  max-width: 100%;
  max-height: 720px;
  object-fit: contain;
  object-position: top left;
}
</style>
