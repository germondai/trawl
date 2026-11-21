<script setup lang="ts">
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"
import { browserChoiceTags } from "~/utils/browser-tags"
import { nativeErrorMessage, t } from "~/utils/localization"

const desktop = useDesktopStore()
const emit = defineEmits<{ connect: [] }>()
const downloads = useBrowserDownloadsStore()
const toast = useToast()
const clearing = shallowRef(false)
const canClear = computed(() => desktop.native && desktop.loaded && !clearing.value && !downloads.pending.length)
const downloading = (version: string) =>
  ["queued", "running", "cancelling"].includes(downloads.jobs[version]?.state ?? "")
const canDownload = computed(() => desktop.native && !desktop.busy)
usePageRefresh(() => desktop.refreshBrowser())
const confirm = shallowRef<{
  action: "repairBrowser" | "uninstallBrowser" | "clearDownloads"
  version?: string
  browserId?: string
}>()
useNavigationModal(confirm, undefined)
const choices = computed(() =>
  (desktop.browser.choices ?? [])
    .map((choice) => ({
      ...choice,
      active: choice.active ?? choice.version === desktop.browser.version,
      installed: choice.installed ?? (choice.version === desktop.browser.version && desktop.browser.installed),
    }))
    .map((choice) => ({ ...choice, tags: browserChoiceTags(choice) })),
)
const changeAllowed = computed(() => desktop.native && !desktop.busy && !desktop.status.running)
async function install(version: string) {
  await downloads.start(version)
}
async function activate(version: string) {
  await desktop.action(() => desktop.management({ action: "activateBrowser", browserVersion: version }))
}
async function change() {
  const operation = confirm.value
  if (!operation) return
  if (operation.action === "clearDownloads") {
    if (!canClear.value) return
    confirm.value = undefined
    clearing.value = true
    try {
      await desktop.management({ action: "clearStorage", storage: "downloads" })
      toast.add({ title: t("ui.browserDownloadCacheCleared"), color: "success" })
    } catch (cause) {
      toast.add({ title: t("ui.couldNotClearDownloadCache"), description: nativeErrorMessage(cause), color: "error" })
    } finally {
      clearing.value = false
    }
    return
  }
  if (operation.action === "repairBrowser") {
    confirm.value = undefined
    await downloads.start(operation.version!, "repairBrowser")
    return
  }
  if (!changeAllowed.value) return
  if (
    await desktop.action(() =>
      desktop.management({
        action: operation.action,
        browserVersion: operation.version,
        browserId: operation.browserId,
        activate: operation.version === desktop.browser.version,
      }),
    )
  )
    confirm.value = undefined
}
const confirmDescription = computed(() =>
  confirm.value?.action === "clearDownloads"
    ? t("ui.removeCachedArchivesAndInterruptedDownloadsInstalledBrowsers")
    : confirm.value?.action === "uninstallBrowser"
      ? t("ui.removeFromThisDeviceOtherBuildsSettingsAnd", {
          p0: confirm.value.version ? `Camoufox ${confirm.value.version}` : t("browser.incompleteInstallation"),
        })
      : t("ui.downloadAndVerifyAFreshCopyOfCamoufox", { p0: confirm.value?.version }),
)
</script>
<template>
  <section class="panel">
    <div class="panel-heading" data-tour="browser">
      <div class="browser-heading">
        <UIcon name="i-lucide-globe" class="size-5" />
        <h2>{{ desktop.browser.system ? t("ui.androidSystemWebview") : t("ui.browserInstallations") }}</h2>
      </div>
      <UBadge v-if="!desktop.browser.system" color="neutral" variant="subtle"
        >{{ choices.filter((choice) => choice.installed || choice.present).length }}
        {{ t("ui.installed2") }}</UBadge
      >
    </div>
    <p v-if="desktop.browser.system" class="panel-body text-sm muted">
      {{ t("ui.androidProvidesAndUpdatesThisBrowserTrawlUses") }}
      <UButton class="mt-3" icon="i-lucide-network" color="neutral" variant="outline" @click="emit('connect')">{{
        t("ui.connectAFullTrawlInstance")
      }}</UButton>
    </p>
    <div v-else class="panel-body text-sm muted">
      <p>{{ t("ui.trawlInstallsAndManagesItsOwnCamoufoxBrowsers") }}</p>
      <p v-if="desktop.status.running" class="mt-2 text-xs">
        {{ t("ui.downloadsContinueWhileTheServerRunsStopThe") }}
      </p>
    </div>
    <div class="browser-builds">
      <div v-for="choice in choices" :key="choice.id ?? choice.version" class="browser-build">
        <div class="browser-build-main">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <strong>{{ choice.name }}</strong><span class="mono text-sm">{{ choice.version }}</span>
              <BrowserTagBadge v-for="tag in choice.tags" :key="tag" :tag="tag" />
            </div>
            <p class="text-xs muted mt-1">
              {{
                choice.supported === false
                  ? t("ui.thisInstallationCannotBeUsedByTrawlYou")
                  : choice.installed
                    ? t("ui.availableOnThisDevice")
                    : t("browser.downloadSize", { size: Math.ceil(choice.downloadBytes / 1048576) })
              }}
            </p>
          </div>
          <div class="actions shrink-0">
            <UButton
              v-if="choice.supported !== false && !choice.installed && !choice.pending && !downloading(choice.version)"
              color="neutral"
              variant="outline"
              :disabled="!canDownload"
              @click="install(choice.version)"
              >{{
                downloads.jobs[choice.version]?.state === "error" ? t("ui.retry") : t("ui.install")
              }}</UButton
            >
            <UButton
              v-else-if="choice.supported !== false && !downloading(choice.version)"
              color="neutral"
              variant="outline"
              :disabled="!changeAllowed || (choice.active && !choice.pending)"
              @click="activate(choice.version)"
              >{{
                choice.pending ? t("ui.applyRepair") : choice.active ? t("ui.inUse") : t("ui.useVersion")
              }}</UButton
            >
            <AppTooltip
              v-if="choice.supported !== false && (choice.installed || choice.state === 'repair-needed')"
              :text="t('ui.repairThisVersion')"
              ><UButton
                icon="i-lucide-wrench"
                color="neutral"
                variant="ghost"
                :aria-label="t('ui.repair', { p0: choice.version })"
                :disabled="!canDownload || downloading(choice.version)"
                @click="confirm = { action: 'repairBrowser', version: choice.version }"
              /></AppTooltip
            >
            <AppTooltip
              v-if="choice.installed || choice.present || choice.state === 'repair-needed'"
              :text="t('ui.removeThisVersion')"
              ><UButton
                icon="i-lucide-trash-2"
                color="neutral"
                variant="ghost"
                :aria-label="t('ui.remove', { p0: choice.version })"
                :disabled="!changeAllowed || (choice.supported !== false && downloading(choice.version))"
                @click="confirm = { action: 'uninstallBrowser', version: choice.version, browserId: choice.id }"
              /></AppTooltip
            >
          </div>
        </div>
        <div
          v-if="choice.supported !== false && downloads.jobs[choice.version]?.state === 'queued'"
          class="flex items-center justify-between gap-3 mt-4"
        >
          <span class="text-xs muted">{{ t("ui.waitingForADownloadSlot") }}</span
          ><UButton color="neutral" variant="ghost" size="xs" @click="downloads.cancel(choice.version)">{{
            t("ui.cancelDownload")
          }}</UButton>
        </div>
        <OperationProgress
          v-else-if="choice.supported !== false && downloading(choice.version)"
          :progress="downloads.jobs[choice.version]!.progress"
          :cancelling="downloads.jobs[choice.version]!.state === 'cancelling'"
          @cancel="downloads.cancel(choice.version)"
        />
        <p
          v-if="choice.supported !== false && downloads.jobs[choice.version]?.state === 'error'"
          class="notice error text-xs"
          role="alert"
        >
          {{ nativeErrorMessage(downloads.jobs[choice.version]?.error) }}
        </p>
      </div>
    </div>
    <p v-if="!desktop.browser.system && !choices.length" class="panel-body muted">
      {{ t("ui.noSupportedBrowserBuildsAreAvailableOnThis") }}
    </p>
    <p v-if="desktop.browser.inventoryLimited" class="panel-body notice text-sm">
      {{ t("ui.onlyTheFirst128StoredEntriesAreShown") }}
    </p>
    <div v-if="!desktop.browser.system" class="panel-body border-t border-default browser-cache-footer">
      <p class="text-xs muted">
        {{ t("ui.interruptedArchivesOlderThan24HoursAreCleared") }}
      </p>
      <AppTooltip
        :text="
          downloads.pending.length
            ? t('ui.waitForBrowserDownloadsToFinish')
            : t('ui.removeCachedAndInterruptedBrowserDownloads')
        "
      >
        <span class="shrink-0"
          ><UButton
            icon="i-lucide-trash-2"
            color="neutral"
            variant="ghost"
            class="whitespace-nowrap"
            :loading="clearing"
            :disabled="!canClear"
            @click="confirm = { action: 'clearDownloads' }"
            >{{
              t("ui.clearDownloadCache")
            }}</UButton
          ></span
        >
      </AppTooltip>
    </div>
  </section>
  <AppDialog
    :open="Boolean(confirm)"
    :content="confirmationContent"
    :title="
      confirm?.action === 'clearDownloads'
        ? t('ui.clearBrowserDownloadCache')
        : confirm?.action === 'uninstallBrowser'
          ? t('ui.removeBrowserVersion')
          : t('ui.repairBrowserVersion')
    "
    :description="confirmDescription"
    :dismissible="!desktop.busy"
    @update:open="if (!$event) confirm = undefined;"
  >
    <template v-if="desktop.error && confirm?.action !== 'clearDownloads'" #body
      ><p class="notice error" role="alert">{{ desktop.error }}</p></template
    >
    <template #footer
      ><UButton color="neutral" variant="outline" :disabled="desktop.busy" @click="confirm = undefined">{{
        t("ui.cancel")
      }}</UButton><UButton
        data-confirm-default
        :color="confirm?.action === 'repairBrowser' ? 'primary' : 'error'"
        :disabled="
          confirm?.action === 'clearDownloads'
            ? !canClear
            : confirm?.action === 'repairBrowser'
              ? !canDownload
              : !changeAllowed
        "
        @click="change"
        >{{
          confirm?.action === "clearDownloads"
            ? t("ui.clearCache")
            : confirm?.action === "uninstallBrowser"
              ? t("ui.removeVersion")
              : t("ui.repairVersion")
        }}</UButton
      ></template
    >
  </AppDialog>
</template>
<style scoped>
.browser-cache-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.browser-build {
  padding: 20px 24px;
  border-top: 1px solid var(--ui-border);
}
.browser-build-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
@media (max-width: 720px) {
  .browser-cache-footer {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .browser-build-main {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
