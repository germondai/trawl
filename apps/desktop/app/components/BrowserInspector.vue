<script setup lang="ts">
import { type BrowserObservationSnapshot, TrawlError } from "@trawl/client"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { browserSnapshotKey } from "~/utils/browser-snapshot"
import { validateJpegPreview } from "~/utils/jpeg-preview"
import { formatLocale, LocalizedError, nativeErrorMessage, t } from "~/utils/localization"

const emit = defineEmits<{ history: [id: string]; workbench: [] }>()
const desktop = useDesktopStore()
const workbench = useWorkbenchStore()
const visible = useDocumentVisibility()
const stopped = computed(() => desktop.activeId === "local" && !desktop.status.running)
const supported = computed(() => Boolean(desktop.native && desktop.capabilities?.browserInspection))
const enabled = computed(() => supported.value && visible.value === "visible")
const key = computed(() => `${desktop.activeId}:${desktop.active?.baseURL}`)
const record = shallowRef<{ key: string; value: BrowserObservationSnapshot }>()
const snapshot = computed(() => (enabled.value && record.value?.key === key.value ? record.value.value : undefined))
const metadataError = useErrorMessage()
const loading = shallowRef(false)
const { revision, refresh, finish } = useRefreshRevision()
usePageRefresh(async () => {
  await refresh()
  await refreshFrame()
})
const selectedId = shallowRef("")
const selected = computed(() => snapshot.value?.pages.find((page) => page.id === selectedId.value))
const items = computed(
  () =>
    snapshot.value?.pages.map((page) => ({
      label: `${page.origin} · ${t(`browser.state.${page.state}`)}`,
      value: page.id,
    })) ?? [],
)
const live = shallowRef(false)
const { revision: frameRevision, refresh: refreshFrame, finish: finishFrame } = useRefreshRevision()
const frameLoading = shallowRef(false)
const frameError = useErrorMessage()
const debugBusy = shallowRef(false)
const debugError = useErrorMessage()
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
      debugError.value = new LocalizedError("errors.refreshBrowserPages", {
        get error() {
          return nativeErrorMessage(cause) || t("errors.debugOperation")
        },
        id,
      })
  } finally {
    if (!controller.signal.aborted && key.value === identity) debugBusy.value = false
  }
}
const image = shallowRef<{ key: string; url: string; receivedAt: number }>()
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
  async ([identity, allowed, refreshCount], _, onCleanup) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
    onCleanup(() => {
      finish(refreshCount)
      controller.abort()
      clearTimeout(timer)
      wake?.()
    })
    metadataError.value = ""
    loading.value = false
    if (!allowed) {
      finish(refreshCount)
      record.value = undefined
      selectedId.value = ""
      live.value = false
      return
    }
    try {
      while (!controller.signal.aborted) {
        loading.value = !record.value
        const value = await desktop.client().browser.list({ signal: controller.signal, timeoutMs: 5000 })
        if (controller.signal.aborted || key.value !== identity) return
        if (record.value?.key !== identity || browserSnapshotKey(record.value.value) !== browserSnapshotKey(value))
          record.value = { key: identity, value }
        if (selectedId.value && !value.pages.some((page) => page.id === selectedId.value)) selectedId.value = ""
        loading.value = false
        finish(refreshCount)
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, 2000)
        })
        wake = undefined
        timer = undefined
      }
    } catch (cause) {
      if (!controller.signal.aborted && key.value === identity)
        metadataError.value =
          cause instanceof Error || typeof cause === "string"
            ? cause
            : new LocalizedError("ui.browserPagesAreUnavailable")
    } finally {
      finish(refreshCount)
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
      finishFrame(refreshCount)
      controller.abort()
      clearTimeout(timer)
      wake?.()
    })
    frameLoading.value = false
    if (!allowed || !selected.value) {
      finishFrame(refreshCount)
      image.value = undefined
      frameError.value = ""
      return
    }
    const selectedNew = selection !== previous?.[0],
      requested = refreshCount !== previous?.[4]
    if (!refreshing && !selectedNew && !requested) {
      finishFrame(refreshCount)
      if (identity !== previous?.[1]) {
        image.value = undefined
        frameError.value = new LocalizedError("ui.thePageChangedRefreshTheImageToInspect")
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
        image.value = { key: identity, url, receivedAt: Date.now() }
        frameError.value = ""
      } catch (cause) {
        if (controller.signal.aborted || frameKey.value !== identity) return
        frameError.value =
          cause instanceof Error || typeof cause === "string"
            ? cause
            : new LocalizedError("ui.pagePreviewIsUnavailable")
        const transient =
          cause instanceof TrawlError &&
          ([409, 429, 503].includes(cause.status ?? 0) || cause.kind === "network" || cause.kind === "timeout")
        if (!live.value || !transient) break
      } finally {
        finishFrame(refreshCount)
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
  <section class="panel" :aria-label="t('ui.activeBrowserPages')">
    <div class="panel-heading gap-3 flex-wrap">
      <h2>{{ t("ui.activeBrowserPages") }}</h2>
    </div>
    <div class="panel-body form-stack">
      <div v-if="stopped" class="form-stack">
        <p class="muted">{{ t("ui.startTheLocalServerToInspectItsBrowser") }}</p>
        <p v-if="desktop.effective.BROWSER_INSPECTION_ENABLED === 'false'" class="text-xs muted">
          {{ t("ui.browserInspectionIsDisabledEnable") }} <SettingLink name="BROWSER_INSPECTION_ENABLED" />
          {{ t("ui.beforeStarting") }}
        </p>
      </div>
      <p v-else-if="desktop.activeId !== 'local' && !desktop.health" class="muted">
        {{ t("ui.thisInstanceIsUnavailableReconnectToInspectBrowser") }}
      </p>
      <p v-else-if="!supported" class="muted">
        {{ t("ui.enable") }} <SettingLink name="BROWSER_INSPECTION_ENABLED" /> {{ t("ui.togetherWith") }}
        <SettingLink name="OBSERVABILITY_ENABLED">{{ t("ui.authenticatedObservability") }}</SettingLink>
        {{ t("ui.onThisInstanceThenRestart") }}
      </p>
      <template v-else>
        <p v-if="metadataError" class="notice" role="status">{{ metadataError }}</p>
        <p v-if="!snapshot?.pages.length" class="muted" role="status">
          {{ loading ? t("ui.lookingForOpenPages") : t("ui.noObservedBrowserPagesAreOpenBrowserBacked") }}
        </p>
        <template v-else>
          <UFormField
            :label="t('ui.pageToInspect')"
            :description="t('ui.originsAreShownWithoutTargetPathsQueryStrings')"
          >
            <USelect
              v-model="selectedId"
              :items="items"
              :placeholder="t('ui.selectAnOpenPage')"
              class="w-full"
              :ui="{ value: 'truncate' }"
            />
          </UFormField>
          <p v-if="snapshot.truncated" class="notice">
            {{ t("ui.thePageListReachedIts128PageLimit") }}
          </p>
          <template v-if="selected">
            <dl class="inspector-facts">
              <div>
                <dt>{{ t("ui.currentOrigin") }}</dt>
                <dd class="mono break-all">{{ selected.origin }}</dd>
              </div>
              <div>
                <dt>{{ t("ui.browser") }}</dt>
                <dd>{{ selected.browserId }} · {{ t(`browser.display.${selected.display}`) }}</dd>
              </div>
              <div v-if="selected.sessionId">
                <dt>{{ t("ui.session") }}</dt>
                <dd class="mono break-all">{{ selected.sessionId }}</dd>
              </div>
              <div v-if="selected.requestId">
                <dt>{{ t("ui.request") }}</dt>
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
              <USwitch v-model="live" :label="live && frameError ? t('ui.livePreviewPaused') : t('ui.livePreview')" />
            </div>
            <UButton
              v-if="selected.sessionId?.startsWith('desktop-debug-')"
              color="neutral"
              variant="outline"
              class="self-start"
              :disabled="selected.state !== 'session-idle'"
              :loading="debugBusy"
              @click="debugSession(true)"
              >{{
                t("ui.closeDebugSession")
              }}</UButton
            >
            <p v-if="frameError" class="notice" role="status">{{ frameError }}</p>
            <p v-else-if="frameLoading && !currentImage" class="muted" role="status">
              {{ t("ui.capturingTheExistingPage") }}
            </p>
            <template v-if="currentImage"
              ><img
                :src="currentImage.url"
                :alt="t('ui.previewOfTheSelectedExistingBrowserPage')"
                class="inspector-image"
              />
              <p class="text-xs muted">
                {{ t("ui.lastReceived") }}
                {{ new Date(currentImage.receivedAt).toLocaleTimeString(formatLocale(), { timeZoneName: "short" }) }} ·
                {{ live ? (frameError ? t("ui.liveRefreshPaused") : t("ui.liveRefreshOn")) : t("ui.singleImage") }}
              </p></template
            >
            <p class="text-xs muted">
              {{ t("ui.thisObservesTheExistingPageWithoutNavigationOr") }}
            </p>
          </template>
        </template>
        <p v-if="snapshot?.headedDebug.display === 'virtual-display'" class="text-xs muted">
          {{ t("ui.thisHostUsesAVirtualLinuxDisplayFor") }}
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
            >{{
              t("ui.openHeadedDebugSession")
            }}</UButton
          >
          <p v-if="snapshot.headedDebug.configured" class="text-xs muted">
            {{ t("ui.opensAVisibleBrowserOnTheInstanceHost") }}
          </p>
          <p v-else class="text-xs muted">
            {{ t("ui.set") }}
            <SettingLink name="BROWSER_HEADFUL_POOL_SIZE">{{ t("ui.extraHeadfulBrowsers") }}</SettingLink>
            {{ t("ui.aboveZeroAndRestartWhileIdleToEnable") }}
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
