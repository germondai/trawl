<script setup lang="ts">
import { t } from "~/utils/localization"

const emit = defineEmits<{ browse: [] }>()
const downloads = useBrowserDownloadsStore()
const open = shallowRef(false)
const running = computed(() => downloads.pending.filter((job) => job.state !== "queued").length)
watch(
  () => downloads.pending.length,
  (count) => {
    if (!count) open.value = false
  },
)
</script>
<template>
  <UPopover v-model:open="open" :content="{ side: 'top', align: 'end', sideOffset: 12 }">
    <AppTooltip :text="t('ui.browserDownloads')"
      ><UButton
        icon="i-lucide-download"
        color="neutral"
        variant="outline"
        class="download-queue-fab"
        :aria-label="t('ui.browserDownloads')"
      >
        <span class="queue-count" aria-hidden="true">{{ downloads.pending.length }}</span>
      </UButton></AppTooltip
    >
    <template #content>
      <section class="download-queue" :aria-label="t('ui.downloadQueue')">
        <div class="queue-heading">
          <strong>{{ t("ui.browserDownloads") }}</strong
          ><span class="muted text-xs"
            >{{ running }} {{ t("ui.running") }} {{ downloads.pending.length - running }} {{ t("ui.queued") }}</span
          >
        </div>
        <div class="queue-items">
          <div v-for="job in downloads.pending" :key="job.id" class="queue-item">
            <strong class="text-sm">{{ t("ui.camoufox") }} <span class="mono">{{ job.version }}</span></strong>
            <div v-if="job.state === 'queued'" class="flex items-center justify-between gap-3 mt-2">
              <span class="text-xs muted">{{ t("ui.waitingForADownloadSlot") }}</span
              ><UButton size="xs" color="neutral" variant="ghost" @click="downloads.cancel(job.version)">{{
                t("ui.cancel")
              }}</UButton>
            </div>
            <OperationProgress
              v-else
              :progress="job.progress"
              :cancelling="job.state === 'cancelling'"
              @cancel="downloads.cancel(job.version)"
            />
          </div>
        </div>
        <UButton
          class="queue-browse"
          color="neutral"
          variant="ghost"
          @click="
            open = false;
            emit('browse');
          "
          >{{
            t("ui.browserInstallations")
          }}</UButton
        >
      </section>
    </template>
  </UPopover>
</template>
<style scoped>
.download-queue-fab {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  justify-content: center;
  background: var(--ui-bg-elevated);
  box-shadow: 0 2px 8px #0004;
}
.queue-count {
  position: absolute;
  right: -3px;
  top: -3px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--ui-primary);
  color: var(--ui-bg);
  display: grid;
  place-items: center;
  font-size: 11px;
}
.download-queue {
  width: min(380px, calc(100vw - 40px));
}
.queue-heading {
  padding: 16px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--ui-border);
}
.queue-items {
  max-height: min(60vh, 440px);
  overflow-y: auto;
}
.queue-item {
  padding: 16px;
  border-bottom: 1px solid var(--ui-border);
}
.queue-browse {
  margin: 8px;
}
</style>
