<script setup lang="ts">
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { t } from "~/utils/localization"

const instance = useDesktopStore()
const updates = useAppUpdates()
const { current, result, progress, checking, installing, percentage, error, automatic } = updates
const confirm = shallowRef(false)
useNavigationModal(confirm, false)
function install() {
  confirm.value = false
  void updates.install()
}
</script>
<template>
  <section class="panel">
    <div class="panel-heading">
      <h2>{{ t("ui.applicationUpdates") }}</h2>
      <span class="text-xs muted">{{ t("ui.installed") }} {{ current || result?.current || "…" }}</span>
    </div>
    <div class="panel-body form-stack">
      <UFormField
        class="preference-row"
        :ui="{ container: 'preference-control' }"
        :label="t('ui.checkForUpdatesOnLaunch')"
        :description="t('ui.checksTheOfficialReleaseFeedAtMostOnce')"
        ><USwitch v-model="automatic" :aria-label="t('ui.checkForUpdatesOnLaunch')" /></UFormField
      >
      <p v-if="result?.state === 'unpublished'" class="text-sm muted">
        {{ t("ui.theApplicationUpdateFeedHasNotBeenPublished") }}
      </p>
      <p v-else-if="result?.state === 'current'" class="text-sm">{{ t("ui.youHaveTheLatestApplicationVersion") }}</p>
      <template v-else-if="result?.state === 'available'"
        ><p>{{ t("ui.trawlIsAvailable", { p0: result.version }) }}</p>
        <p v-if="result.notes" class="text-sm selectable">{{ result.notes.slice(0, 1200) }}</p></template
      >
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <template v-if="installing"
        ><p class="text-sm" role="status">
          {{ progress.state === "installing" ? t("ui.installingAndRestarting") : t("ui.downloadingUpdate") }}
        </p>
        <UProgress :model-value="percentage" /></template
      >
      <div class="actions update-actions">
        <UButton
          color="neutral"
          variant="outline"
          :loading="checking"
          :disabled="!instance.native || installing"
          @click="updates.check"
          >{{
            t("ui.checkForUpdates")
          }}</UButton
        >
        <UButton
          v-if="result?.state === 'available'"
          icon="i-lucide-download"
          :disabled="installing || instance.settingsDirty"
          @click="confirm = true"
          >{{
            instance.mobile ? t("ui.downloadUpdate") : t("ui.updateAndRestart")
          }}</UButton
        >
      </div>
    </div>
    <p v-if="instance.mobile" class="panel-footer text-xs muted">
      {{ t("ui.androidUpdateUsesBrowser") }}
    </p>
  </section>
  <AppDialog
    v-model:open="confirm"
    :title="t('ui.updateTrawl')"
    :description="instance.mobile ? t('ui.androidUpdateOpenBrowser') : t('ui.downloadAndVerifyTheSignedUpdateThenStop')"
  >
    <template #footer
      ><UButton color="neutral" variant="outline" @click="confirm = false">{{ t("ui.cancel") }}</UButton
      ><UButton @click="install">{{
        instance.mobile ? t("ui.downloadUpdate") : t("ui.updateAndRestart")
      }}</UButton></template
    >
  </AppDialog>
</template>
<style scoped>
.notice {
  margin: 0;
}
@media (max-width: 640px) {
  .panel-footer {
    padding: 16px;
  }
  .update-actions > button {
    flex: 1;
    justify-content: center;
  }
}
</style>
