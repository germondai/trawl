<script setup lang="ts">
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"
import { browserChoiceTags } from "~/utils/browser-tags"

const desktop = useDesktopStore()
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
      toast.add({ title: "Browser download cache cleared", color: "success" })
    } catch (cause) {
      toast.add({ title: "Could not clear download cache", description: String(cause), color: "error" })
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
    ? "Remove cached archives and interrupted downloads? Installed browsers are kept. Interrupted downloads will start again from the beginning."
    : confirm.value?.action === "uninstallBrowser"
      ? `Remove ${confirm.value.version ? `Camoufox ${confirm.value.version}` : "the incomplete installation"} from this device? Other builds, settings and request history are kept.`
      : `Download and verify a fresh copy of Camoufox ${confirm.value?.version}. Other installed builds are kept.`,
)
</script>
<template>
  <section class="panel">
    <div class="panel-heading">
      <div class="browser-heading">
        <UIcon name="i-lucide-globe" class="size-5" />
        <h2>{{ desktop.browser.system ? "Android System WebView" : "Browser installations" }}</h2>
      </div>
      <UBadge v-if="!desktop.browser.system" color="neutral" variant="subtle"
        >{{ choices.filter((choice) => choice.installed || choice.present).length }}
        installed</UBadge
      >
    </div>
    <p v-if="desktop.browser.system" class="panel-body text-sm muted">
      Android provides and updates this browser. TRAWL uses an isolated WebView for rendered GET requests; it does not
      install desktop Camoufox builds on Android.
    </p>
    <p v-else class="panel-body text-sm muted">
      TRAWL installs and manages its own Camoufox browsers. Existing TRAWL installations are detected automatically.
    </p>
    <p v-if="desktop.status.running && !desktop.browser.system" class="panel-body notice text-sm">
      Downloads continue while the server runs. Stop the server to switch or remove a browser.
    </p>
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
                  ? "This installation cannot be used by TRAWL. You can remove it here."
                  : choice.installed
                    ? "Available on this device"
                    : `${Math.ceil(choice.downloadBytes / 1048576)} MiB download`
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
                downloads.jobs[choice.version]?.state === "error" ? "Retry" : "Install"
              }}</UButton
            >
            <UButton
              v-else-if="choice.supported !== false && !downloading(choice.version)"
              color="neutral"
              variant="outline"
              :disabled="!changeAllowed || (choice.active && !choice.pending)"
              @click="activate(choice.version)"
              >{{
                choice.pending ? "Apply repair" : choice.active ? "In use" : "Use version"
              }}</UButton
            >
            <UTooltip
              v-if="choice.supported !== false && (choice.installed || choice.state === 'repair-needed')"
              text="Repair this version"
              ><UButton
                icon="i-lucide-wrench"
                color="neutral"
                variant="ghost"
                :aria-label="`Repair ${choice.version}`"
                :disabled="!canDownload || downloading(choice.version)"
                @click="confirm = { action: 'repairBrowser', version: choice.version }"
              /></UTooltip
            >
            <UTooltip
              v-if="choice.installed || choice.present || choice.state === 'repair-needed'"
              text="Remove this version"
              ><UButton
                icon="i-lucide-trash-2"
                color="neutral"
                variant="ghost"
                :aria-label="`Remove ${choice.version}`"
                :disabled="!changeAllowed || (choice.supported !== false && downloading(choice.version))"
                @click="confirm = { action: 'uninstallBrowser', version: choice.version, browserId: choice.id }"
              /></UTooltip
            >
          </div>
        </div>
        <div
          v-if="choice.supported !== false && downloads.jobs[choice.version]?.state === 'queued'"
          class="flex items-center justify-between gap-3 mt-4"
        >
          <span class="text-xs muted">Waiting for a download slot</span
          ><UButton color="neutral" variant="ghost" size="xs" @click="downloads.cancel(choice.version)"
            >Cancel download</UButton
          >
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
          {{ downloads.jobs[choice.version]?.error }}
        </p>
      </div>
    </div>
    <p v-if="!desktop.browser.system && !choices.length" class="panel-body muted">
      No supported browser builds are available on this platform.
    </p>
    <p v-if="desktop.browser.inventoryLimited" class="panel-body notice text-sm">
      Only the first 128 stored entries are shown. Remove unused installations to reveal more.
    </p>
    <div v-if="!desktop.browser.system" class="panel-body border-t border-default browser-cache-footer">
      <p class="text-xs muted">
        Interrupted archives older than 24 hours are cleared on startup or refresh when no installation is running.
        Cancelled downloads are removed immediately.
      </p>
      <UTooltip
        :text="
          downloads.pending.length
            ? 'Wait for browser downloads to finish'
            : 'Remove cached and interrupted browser downloads'
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
            >Clear download cache</UButton
          ></span
        >
      </UTooltip>
    </div>
  </section>
  <UModal
    :open="Boolean(confirm)"
    :content="confirmationContent"
    :title="
      confirm?.action === 'clearDownloads'
        ? 'Clear browser download cache?'
        : confirm?.action === 'uninstallBrowser'
          ? 'Remove browser version?'
          : 'Repair browser version?'
    "
    :description="confirmDescription"
    :dismissible="!desktop.busy"
    @update:open="if (!$event) confirm = undefined;"
  >
    <template v-if="desktop.error && confirm?.action !== 'clearDownloads'" #body
      ><p class="notice error" role="alert">{{ desktop.error }}</p></template
    >
    <template #footer
      ><UButton color="neutral" variant="outline" :disabled="desktop.busy" @click="confirm = undefined">Cancel</UButton
      ><UButton
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
            ? "Clear cache"
            : confirm?.action === "uninstallBrowser"
              ? "Remove version"
              : "Repair version"
        }}</UButton
      ></template
    >
  </UModal>
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
