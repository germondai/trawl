<script setup lang="ts">
import { type BrowserObservationSnapshot, TrawlError } from "@trawl/client"
import { validateJpegPreview } from "~/utils/jpeg-preview"

const emit = defineEmits<{ history: [id: string]; workbench: [] }>()
const desktop = useDesktopStore()
const workbench = useWorkbenchStore()
const visible = useDocumentVisibility()
const supported = computed(() => Boolean(desktop.native && desktop.capabilities?.browserInspection))
const enabled = computed(() => supported.value && visible.value === "visible")
const key = computed(() => `${desktop.activeId}:${desktop.active?.baseURL}`)
const record = shallowRef<{ key: string; value: BrowserObservationSnapshot }>()
const snapshot = computed(() => (enabled.value && record.value?.key === key.value ? record.value.value : undefined))
const metadataError = shallowRef("")
const loading = shallowRef(false)
const revision = shallowRef(0)
const selectedId = shallowRef("")
const selected = computed(() => snapshot.value?.pages.find((page) => page.id === selectedId.value))
const items = computed(
  () =>
    snapshot.value?.pages.map((page) => ({
      label: `${page.origin} · ${page.state.replaceAll("-", " ")}`,
      value: page.id,
    })) ?? [],
)
const live = shallowRef(false)
const frameRevision = shallowRef(0)
const frameLoading = shallowRef(false)
const frameError = shallowRef("")
const debugBusy = shallowRef(false)
const debugError = shallowRef("")
let debugController: AbortController | undefined
onScopeDispose(() => debugController?.abort())
watch(key, () => {
  debugController?.abort()
  debugBusy.value = false
  debugError.value = ""
})
async function debugSession(close = false) {
  if (debugBusy.value || !snapshot.value) return
  const identity = key.value,
    client = desktop.client(),
    id = close ? selected.value?.sessionId : `desktop-debug-${crypto.randomUUID()}`
  if (!id || !/^desktop-debug-[a-f0-9-]{36}$/.test(id)) return
  const controller = new AbortController()
  debugController?.abort()
  debugController = controller
  debugBusy.value = true
  debugError.value = ""
  live.value = false
  selectedId.value = ""
  await nextTick()
  try {
    if (close) await client.sessions.destroy(id, { signal: controller.signal, timeoutMs: 15000 })
    else {
      await client.sessions.create(
        { id, headful: true, keepPage: true },
        { signal: controller.signal, timeoutMs: 35000 },
      )
      if (controller.signal.aborted || key.value !== identity) return
      workbench.draft.sessionId = id
      if (workbench.draft.maxTier < 3) workbench.draft.maxTier = 3
      emit("workbench")
    }
    if (!controller.signal.aborted && key.value === identity) revision.value++
  } catch (cause) {
    if (!controller.signal.aborted && key.value === identity)
      debugError.value = `${cause instanceof Error ? cause.message : "Debug session operation failed"}. Refresh pages to check session ${id} before retrying.`
  } finally {
    if (!controller.signal.aborted && key.value === identity) debugBusy.value = false
  }
}
const image = shallowRef<{ key: string; url: string; receivedAt: string }>()
const frameKey = computed(
  () =>
    `${key.value}:${selected.value?.id}:${selected.value?.requestId}:${selected.value?.state}:${selected.value?.origin}`,
)
const currentImage = computed(() => (enabled.value && image.value?.key === frameKey.value ? image.value : undefined))
watch(
  key,
  () => {
    selectedId.value = ""
    live.value = false
    record.value = undefined
  },
  { flush: "sync" },
)

watch(
  [key, enabled, revision],
  async ([identity, allowed], _, onCleanup) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
    onCleanup(() => {
      controller.abort()
      clearTimeout(timer)
      wake?.()
    })
    metadataError.value = ""
    loading.value = false
    if (!allowed) {
      record.value = undefined
      selectedId.value = ""
      live.value = false
      return
    }
    try {
      while (!controller.signal.aborted) {
        loading.value = true
        const value = await desktop.client().browser.list({ signal: controller.signal, timeoutMs: 5000 })
        if (controller.signal.aborted || key.value !== identity) return
        record.value = { key: identity, value }
        if (selectedId.value && !value.pages.some((page) => page.id === selectedId.value)) selectedId.value = ""
        loading.value = false
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, 2000)
        })
        wake = undefined
        timer = undefined
      }
    } catch (cause) {
      if (!controller.signal.aborted && key.value === identity)
        metadataError.value = cause instanceof Error ? cause.message : "Browser pages are unavailable"
    } finally {
      if (!controller.signal.aborted && key.value === identity) loading.value = false
    }
  },
  { immediate: true },
)

watch(
  () => image.value?.url,
  (url, _, onCleanup) => {
    if (url) onCleanup(() => URL.revokeObjectURL(url))
  },
  { flush: "sync" },
)
const selectionKey = computed(() => `${key.value}:${selectedId.value}`)
watch(
  [selectionKey, frameKey, enabled, live, frameRevision],
  async ([selection, identity, allowed, refreshing, refreshCount], previous, onCleanup) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
    onCleanup(() => {
      controller.abort()
      clearTimeout(timer)
      wake?.()
    })
    frameLoading.value = false
    if (!allowed || !selected.value) {
      image.value = undefined
      frameError.value = ""
      return
    }
    const selectedNew = selection !== previous?.[0],
      requested = refreshCount !== previous?.[4]
    if (!refreshing && !selectedNew && !requested) {
      if (identity !== previous?.[1]) {
        image.value = undefined
        frameError.value = "The page changed. Refresh the image to inspect its current state."
      }
      return
    }
    if (image.value?.key !== identity) image.value = undefined
    frameError.value = ""
    const id = selected.value.id
    do {
      frameLoading.value = true
      try {
        const bytes = await desktop.client().browser.preview(id, { signal: controller.signal })
        if (controller.signal.aborted || frameKey.value !== identity) return
        validateJpegPreview(bytes, { width: 1280, height: 720 })
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: "image/jpeg" }))
        image.value = { key: identity, url, receivedAt: new Date().toLocaleTimeString() }
        frameError.value = ""
      } catch (cause) {
        if (controller.signal.aborted || frameKey.value !== identity) return
        frameError.value = cause instanceof Error ? cause.message : "Page preview is unavailable"
        const transient =
          cause instanceof TrawlError &&
          ([409, 429, 503].includes(cause.status ?? 0) || cause.kind === "network" || cause.kind === "timeout")
        if (!live.value || !transient) break
      } finally {
        if (!controller.signal.aborted && frameKey.value === identity) frameLoading.value = false
      }
      if (!live.value) break
      await new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, Math.max(1000, snapshot.value?.limits.intervalMs ?? 1000))
      })
      wake = undefined
      timer = undefined
    } while (!controller.signal.aborted)
  },
  { immediate: true },
)
</script>
<template>
  <section class="panel" aria-label="Active browser pages">
    <div class="panel-heading gap-3 flex-wrap">
      <h2>Active browser pages</h2>
      <UButton
        v-if="supported"
        color="neutral"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        :loading="loading"
        @click="revision++"
        >Refresh pages</UButton
      >
    </div>
    <div class="panel-body form-stack">
      <p v-if="!supported" class="muted">
        Browser inspection is unavailable on this instance. On a compatible host, enable BROWSER_INSPECTION_ENABLED
        together with authenticated observability, then restart.
      </p>
      <template v-else>
        <p v-if="metadataError" class="notice" role="status">{{ metadataError }}</p>
        <p v-if="!snapshot?.pages.length" class="muted" role="status">
          {{
            loading
              ? "Looking for open pages…"
              : "No observed browser pages are open. Browser-backed requests appear while running; keep-page sessions remain available while idle."
          }}
        </p>
        <template v-else>
          <UFormField
            label="Page to inspect"
            description="Origins are shown without target paths, query strings or credentials."
          >
            <USelect
              v-model="selectedId"
              :items="items"
              placeholder="Select an open page"
              class="w-full"
              :ui="{ value: 'truncate' }"
            />
          </UFormField>
          <p v-if="snapshot.truncated" class="notice">
            The page list reached its 128-page limit. Some pages are omitted.
          </p>
          <template v-if="selected">
            <dl class="inspector-facts">
              <div>
                <dt>Current origin</dt>
                <dd class="mono break-all">{{ selected.origin }}</dd>
              </div>
              <div>
                <dt>Browser</dt>
                <dd>{{ selected.browserId }} · {{ selected.display.replaceAll("-", " ") }}</dd>
              </div>
              <div v-if="selected.sessionId">
                <dt>Session</dt>
                <dd class="mono break-all">{{ selected.sessionId }}</dd>
              </div>
              <div v-if="selected.requestId">
                <dt>Request</dt>
                <dd>
                  <UButton
                    color="neutral"
                    variant="link"
                    class="mono text-xs break-all"
                    @click="emit('history', selected.requestId)"
                    >{{
                      selected.requestId
                    }}</UButton
                  >
                </dd>
              </div>
            </dl>
            <div class="flex items-center justify-between gap-4 flex-wrap">
              <USwitch v-model="live" :label="live && frameError ? 'Live preview paused' : 'Live preview'" />
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-refresh-cw"
                :loading="frameLoading"
                @click="frameRevision++"
                >Refresh image</UButton
              >
            </div>
            <UButton
              v-if="selected.sessionId?.startsWith('desktop-debug-')"
              color="neutral"
              variant="outline"
              class="self-start"
              :disabled="selected.state !== 'session-idle'"
              :loading="debugBusy"
              @click="debugSession(true)"
              >Close debug session</UButton
            >
            <p v-if="frameError" class="notice" role="status">{{ frameError }}</p>
            <p v-else-if="frameLoading && !currentImage" class="muted" role="status">Capturing the existing page…</p>
            <template v-if="currentImage"
              ><img
                :src="currentImage.url"
                alt="Preview of the selected existing browser page"
                class="inspector-image"
              />
              <p class="text-xs muted">
                Last received {{ currentImage.receivedAt }} ·
                {{ live ? (frameError ? "Live refresh paused" : "Live refresh on") : "Single image" }}
              </p></template
            >
            <p class="text-xs muted">
              This observes the existing page without navigation or interaction. Live refresh is at most once per
              second, pauses when hidden and stops if the page closes. Busy or short-budget operations may skip an
              image.
            </p>
          </template>
        </template>
        <p v-if="snapshot?.headedDebug.display === 'virtual-display'" class="text-xs muted">
          This host uses a virtual Linux display for headed browsers. Its window does not appear on your desktop; use
          the preview here.
        </p>
        <div v-if="snapshot?.headedDebug.supported" class="form-stack">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-globe"
            class="self-start"
            :disabled="!snapshot.headedDebug.configured"
            :loading="debugBusy"
            @click="debugSession()"
            >Open headed debug session</UButton
          >
          <p class="text-xs muted">
            {{
              snapshot.headedDebug.configured
                ? "Opens a visible browser window on the instance host, then selects its retained session in New request. The session stays open until you close it here or it expires; leaving this view does not cancel accepted creation."
                : "Set Browser headful pool size above zero in the host settings and restart while idle to enable visible debug sessions. This is additional browser capacity."
            }}
          </p>
        </div>
        <p v-if="debugError" class="notice" role="status">{{ debugError }}</p>
      </template>
    </div>
  </section>
</template>
<style scoped>
.inspector-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 16px 32px;
  margin: 0;
}
.inspector-facts dt {
  color: var(--ui-text-muted);
  font-size: 12px;
  margin-bottom: 6px;
}
.inspector-facts dd {
  margin: 0;
}
.inspector-image {
  max-width: 100%;
  max-height: 720px;
  object-fit: contain;
  object-position: top left;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
}
</style>
