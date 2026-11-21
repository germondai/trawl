<script setup lang="ts">
import type { InstallationProgress } from "~/stores/desktop"
import { formatLocale, t } from "~/utils/localization"

const props = defineProps<{ progress: InstallationProgress; cancelling?: boolean }>()
const emit = defineEmits<{ cancel: [] }>()
const progress = computed(() => props.progress)
const labels: Record<string, string> = {
  get checking() {
    return t("ui.checkingInstallation")
  },
  get download() {
    return t("ui.downloadingBrowser")
  },
  get extract() {
    return t("ui.extractingBrowser")
  },
  get copy() {
    return t("ui.reusingInstalledBrowser")
  },
  get patch() {
    return t("ui.applyingSecurityUpdates")
  },
  get geoip() {
    return t("ui.preparingGeoipData")
  },
  get addons() {
    return t("ui.installingBrowserAddOns")
  },
  get activate() {
    return t("ui.finishingInstallation")
  },
  get remove() {
    return t("ui.removingBrowser")
  },
  get done() {
    return t("ui.browserOperationComplete")
  },
}
const percent = computed(() =>
  progress.value?.total
    ? Math.min(100, Math.round(((progress.value.completed ?? 0) / progress.value.total) * 100))
    : undefined,
)
const amount = computed(() => {
  const p = progress.value
  if (!p?.total) return ""
  return p.unit === "bytes"
    ? `${((p.completed ?? 0) / 1048576).toLocaleString(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} / ${(p.total / 1048576).toLocaleString(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`
    : t("browser.fileProgress", { completed: p.completed ?? 0, total: p.total })
})
const remaining = computed(() => {
  const ms = progress.value?.etaMs
  if (ms === undefined) return ""
  const duration =
    ms < 60000
      ? t("counts.seconds", { count: Math.max(1, Math.ceil(ms / 1000)) })
      : t("counts.minutes", { count: Math.ceil(ms / 60000) })
  return t("progress.remaining", { duration })
})
</script>
<template>
  <div class="browser-progress form-stack">
    <div class="flex flex-wrap justify-between gap-2">
      <strong role="status" aria-live="polite">{{
        cancelling ? t("ui.cancelling") : (labels[progress.phase] ?? t("ui.preparingBrowser"))
      }}</strong><span v-if="amount" class="mono text-xs muted">{{ amount }}</span>
    </div>
    <UProgress :model-value="percent ?? null" :max="100" :aria-label="t('ui.browserDownloadProgress')" />
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs muted">
        {{
          remaining || (progress.phase === "done" ? t("ui.ready") : t("ui.timeRemainingWillAppearWhenEnoughProgressIs"))
        }}
      </p>
      <UButton size="xs" color="neutral" variant="ghost" :disabled="cancelling" @click="emit('cancel')">{{
        t("ui.cancelDownload")
      }}</UButton>
    </div>
  </div>
</template>

<style scoped>
.browser-progress {
  margin-top: 16px;
}
</style>
