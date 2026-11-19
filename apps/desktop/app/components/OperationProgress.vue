<script setup lang="ts">
import type { InstallationProgress } from "~/stores/desktop"

const props = defineProps<{ progress: InstallationProgress; cancelling?: boolean }>()
const emit = defineEmits<{ cancel: [] }>()
const progress = computed(() => props.progress)
const labels: Record<string, string> = {
  checking: "Checking installation",
  download: "Downloading browser",
  extract: "Extracting browser",
  copy: "Reusing installed browser",
  patch: "Applying security updates",
  geoip: "Preparing GeoIP data",
  addons: "Installing browser add-ons",
  activate: "Finishing installation",
  remove: "Removing browser",
  done: "Browser operation complete",
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
    ? `${((p.completed ?? 0) / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MiB`
    : `${p.completed ?? 0} / ${p.total} files`
})
const remaining = computed(() => {
  const ms = progress.value?.etaMs
  if (ms === undefined) return ""
  return ms < 60000
    ? `About ${Math.max(1, Math.ceil(ms / 1000))} seconds remaining in this phase`
    : `About ${Math.ceil(ms / 60000)} minutes remaining in this phase`
})
</script>
<template>
  <div class="browser-progress form-stack">
    <div class="flex flex-wrap justify-between gap-2">
      <strong role="status" aria-live="polite">{{
        cancelling ? "Cancelling…" : (labels[progress.phase] ?? "Preparing browser")
      }}</strong><span v-if="amount" class="mono text-xs muted">{{ amount }}</span>
    </div>
    <UProgress :model-value="percent ?? null" :max="100" aria-label="Browser download progress" />
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs muted">
        {{
          remaining ||
          (progress.phase === "done" ? "Ready" : "Time remaining will appear when enough progress is available")
        }}
      </p>
      <UButton size="xs" color="neutral" variant="ghost" :disabled="cancelling" @click="emit('cancel')"
        >Cancel download</UButton
      >
    </div>
  </div>
</template>

<style scoped>
.browser-progress {
  margin-top: 16px;
}
</style>
