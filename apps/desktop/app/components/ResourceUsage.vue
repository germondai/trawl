<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"
import { formatLocale, t } from "~/utils/localization"
import { type Page, pages } from "~/utils/page-history"

interface Resources {
  sampledAt: number
  cpuPercent: number | null
  logicalCpus: number
  memoryBytes: number
  hostMemory: { totalBytes: number; availableBytes: number }
  processes: { pid: number; name: string; memoryBytes: number; cpuPercent: number | null }[]
  disk: {
    entries: { name: string; bytes: number; partial: boolean }[]
  }
}
const desktop = useDesktopStore()
const browserDownloads = useBrowserDownloadsStore()
const downloading = computed(() =>
  Object.values(browserDownloads.jobs).some((job) => ["running", "cancelling"].includes(job.state)),
)
const emit = defineEmits<{ navigate: [page: Page] }>()
const visible = useDocumentVisibility()
const data = shallowRef<Resources>()
const storageEntries = computed(() => {
  const entries = (data.value?.disk.entries ?? []).map((entry) => ({ ...entry, location: entry.name }))
  const browsers = entries.filter((entry) => ["Browser", "Stored browsers"].includes(entry.name))
  const metrics = entries.filter((entry) => ["Metrics", "Metrics journal"].includes(entry.name))
  const application = entries.filter((entry) => ["Desktop executable", "Bundled runtime"].includes(entry.name))
  const grouped = entries.filter(
    (entry) => !application.includes(entry) && !metrics.includes(entry) && !browsers.includes(entry),
  )
  if (application.length)
    grouped.push({
      name: "Application & runtime",
      bytes: application.reduce((sum, entry) => sum + entry.bytes, 0),
      partial: application.some((entry) => entry.partial),
      location: application.find((entry) => entry.name === "Desktop executable")?.name ?? application[0]!.name,
    })
  if (metrics.length)
    grouped.push({
      name: "Metrics",
      bytes: metrics.reduce((sum, entry) => sum + entry.bytes, 0),
      partial: metrics.some((entry) => entry.partial),
      location: metrics.find((entry) => entry.name === "Metrics")?.name ?? metrics[0]!.name,
    })
  if (browsers.length)
    grouped.push({
      name: "Browser",
      bytes: browsers.reduce((sum, entry) => sum + entry.bytes, 0),
      partial: browsers.some((entry) => entry.partial),
      location: "Browser",
    })
  return grouped.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
})
const storageBytes = computed(() => data.value?.disk.entries.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0)
const storagePartial = computed(() => data.value?.disk.entries.some((entry) => entry.partial))
const error = useErrorMessage()
const loading = shallowRef(false)
const clearing = shallowRef<"logs" | "downloads" | "history" | "captures">()
useNavigationModal(clearing, undefined)
const clearable: Record<string, "logs" | "downloads" | "history" | "captures"> = {
  Logs: "logs",
  Downloads: "downloads",
  Metrics: "history",
  "Metrics journal": "history",
  "Request and response captures": "captures",
}
const storagePages: Record<string, Page> = {
  Browser: "browser",
  "Application & runtime": "connections",
}
const resourceLabels: Record<string, string> = {
  Browser: "ui.browser",
  "Stored browsers": "ui.storedBrowsers",
  Metrics: "ui.metrics",
  "Metrics journal": "resources.metricsJournal",
  "Desktop executable": "ui.desktopExecutable",
  "Bundled runtime": "ui.bundledRuntime",
  "Application & runtime": "resources.applicationRuntime",
  "Request and response captures": "resources.captures",
  Configuration: "resources.configuration",
  Downloads: "resources.downloads",
  Logs: "ui.logs",
}
const resourceName = (name: string) => (resourceLabels[name] ? t(resourceLabels[name]!) : name)
const storagePageLabel = (name: string) =>
  pages.find((page) => page.id === storagePages[name])?.label ?? t("ui.serverSettings")
const fileManager = computed(() =>
  desktop.mobile
    ? t("ui.androidAppStorageSettings")
    : /Mac/.test(navigator.platform)
      ? t("ui.finder")
      : /Win/.test(navigator.platform)
        ? t("ui.explorer")
        : t("ui.fileManager"),
)
const local = computed(() => desktop.activeId === "local")
const memoryMax = computed(() => desktop.health?.memory?.limitBytes || data.value?.hostMemory.totalBytes)
const bytes = (value: number | null | undefined) =>
  value == null
    ? t("ui.notReported")
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toLocaleString(formatLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GiB`
      : value >= 1024 ** 2
        ? `${(value / 1024 ** 2).toLocaleString(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`
        : value >= 1024
          ? `${(value / 1024).toLocaleString(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KiB`
          : `${value} B`
const cpu = (value: number | null | undefined) =>
  value == null
    ? t("ui.sampling")
    : `${value.toLocaleString(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
let disposed = false
async function refresh(fresh = false) {
  if (loading.value || !desktop.native || !local.value || visible.value !== "visible") return
  loading.value = true
  try {
    const value = await invoke<Resources>("resource_usage", { fresh })
    if (!disposed && local.value) {
      data.value = value
      error.value = ""
    }
  } catch (cause) {
    if (!disposed && local.value) error.value = cause
  } finally {
    if (!disposed) loading.value = false
  }
}
async function reveal(name: string) {
  try {
    await invoke("reveal_storage", { name })
  } catch (cause) {
    error.value = cause
  }
}
async function clear() {
  const storage = clearing.value
  if (
    !storage ||
    (storage !== "downloads" && desktop.status.running) ||
    desktop.busy ||
    (storage === "downloads" && downloading.value)
  )
    return
  clearing.value = undefined
  if (await desktop.action(() => desktop.management({ action: "clearStorage", storage }))) await refresh(true)
}
usePageRefresh(() => refresh(true))
const { pause, resume } = useIntervalFn(refresh, 5000, { immediate: false })
watch(
  [local, visible],
  ([isLocal, visibility]) => {
    pause()
    if (isLocal && visibility === "visible") {
      void refresh()
      resume()
    }
  },
  { immediate: true },
)
onScopeDispose(() => {
  disposed = true
  pause()
})
</script>
<template>
  <template v-if="!local">
    <div class="notice">
      {{ t("ui.processAndDiskMetricsAreAvailableForLocal") }}
    </div>
    <div v-if="desktop.health?.memory" class="panel panel-body">
      <h2>{{ t("ui.remoteMemory") }}</h2>
      <p class="mono mt-4">
        {{ bytes(desktop.health.memory.workingSetBytes ?? desktop.health.memory.currentBytes)
        }}<span class="muted"> / {{ bytes(desktop.health.memory.limitBytes) }} {{ t("ui.limit") }}</span>
      </p>
    </div>
  </template>
  <template v-else>
    <div v-if="data" class="stats">
      <div class="stat">
        <div class="stat-label">{{ t("ui.trawlProcessTreesCpu") }}</div>
        <div class="stat-value mono">{{ cpu(data.cpuPercent) }}</div>
        <p class="stat-hint">{{ t("ui.100RepresentsOneLogicalCpu") }}</p>
        <MetricBar
          :value="data.cpuPercent"
          :max="data.logicalCpus * 100"
          :label="t('resources.cpuSummary', { usage: cpu(data.cpuPercent), count: data.logicalCpus })"
        />
      </div>
      <div class="stat">
        <div class="stat-label">{{ t("ui.residentMemory") }}</div>
        <div class="stat-value mono">{{ bytes(data.memoryBytes) }}</div>
        <p class="stat-hint">
          {{ data.processes.length }} {{ t("ui.processes") }} {{ bytes(memoryMax) }}
          {{ desktop.health?.memory?.limitBytes ? t("ui.limit") : t("ui.deviceTotal") }}
        </p>
        <MetricBar
          :value="data.memoryBytes"
          :max="memoryMax"
          :label="t('resources.memorySummary', { used: bytes(data.memoryBytes), total: bytes(memoryMax) })"
        />
      </div>
      <div class="stat">
        <div class="stat-label">{{ t("ui.deviceMemoryAvailable") }}</div>
        <div class="stat-value mono">{{ bytes(data.hostMemory.availableBytes) }}</div>
        <p class="stat-hint">{{ bytes(data.hostMemory.totalBytes) }} {{ t("ui.installed2") }}</p>
        <MetricBar
          :value="data.hostMemory.availableBytes"
          :max="data.hostMemory.totalBytes"
          :label="
            t('resources.availableMemory', {
              available: bytes(data.hostMemory.availableBytes),
              total: bytes(data.hostMemory.totalBytes),
            })
          "
        />
      </div>
    </div>
    <section v-if="data" class="panel">
      <div class="panel-heading">
        <h2>{{ t("ui.processes2") }}</h2>
      </div>
      <div class="table-wrap">
        <table class="request-table">
          <thead>
            <tr>
              <th>{{ t("ui.process") }}</th>
              <th>PID</th>
              <th>CPU</th>
              <th>{{ t("ui.memory") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="process in data.processes" :key="process.pid">
              <td>{{ process.name === "TRAWL app" ? t("resources.appProcess") : process.name }}</td>
              <td class="mono">{{ process.pid }}</td>
              <td class="mono">{{ cpu(process.cpuPercent) }}</td>
              <td class="mono">{{ bytes(process.memoryBytes) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="panel-body text-xs muted">
        {{ t("ui.includesTheDesktopLocalServerAndTheirDescendants") }}
      </p>
    </section>
    <section v-if="data" class="panel">
      <div class="panel-heading">
        <h2>{{ t("ui.managedStorage") }}</h2>
        <span class="text-xs mono muted"
          >{{ storagePartial ? t("ui.atLeast") : "" }}{{ bytes(storageBytes) }} {{ t("ui.used") }}</span
        >
      </div>
      <dl class="browser-details managed-storage">
        <div v-for="entry in storageEntries" :key="entry.name">
          <dt>{{ resourceName(entry.name) }}</dt>
          <dd class="storage-actions">
            <span class="mono">{{ entry.partial ? t("ui.atLeast") : "" }}{{ bytes(entry.bytes) }}</span>
            <AppTooltip :text="t('ui.showIn', { p0: fileManager })"
              ><UButton
                icon="i-lucide-folder-open"
                class="size-8 justify-center"
                color="neutral"
                variant="ghost"
                :aria-label="t('ui.showIn2', { p0: resourceName(entry.name), p1: fileManager })"
                :disabled="!desktop.native"
                @click="reveal(entry.location)"
              /></AppTooltip
            >
            <AppTooltip
              v-if="clearable[entry.name]"
              :text="
                desktop.status.running && clearable[entry.name] !== 'downloads'
                  ? t('ui.stopTheLocalServerToClearStorage')
                  : clearable[entry.name] === 'history'
                    ? t('ui.clearMetricsAndRequestHistory')
                    : clearable[entry.name] === 'captures'
                      ? t('ui.clearRequestAndResponseCaptures')
                      : t('ui.clear', { p0: resourceName(entry.name) })
              "
              ><span
                ><UButton
                  icon="i-lucide-trash-2"
                  class="size-8 justify-center"
                  color="neutral"
                  variant="ghost"
                  :aria-label="
                    clearable[entry.name] === 'history'
                      ? t('ui.clearMetricsAndRequestHistory')
                      : clearable[entry.name] === 'captures'
                        ? t('ui.clearRequestAndResponseCaptures')
                        : t('ui.clear', { p0: resourceName(entry.name) })
                  "
                  :disabled="
                    !desktop.native ||
                    desktop.busy ||
                    (desktop.status.running && clearable[entry.name] !== 'downloads') ||
                    entry.bytes === 0 ||
                    (clearable[entry.name] === 'downloads' && downloading)
                  "
                  @click="clearing = clearable[entry.name]"
                /></span
              ></AppTooltip
            >
            <AppTooltip v-else :text="t('ui.open', { p0: storagePageLabel(entry.name) })">
              <UButton
                icon="i-lucide-arrow-up-right"
                class="size-8 justify-center"
                color="neutral"
                variant="ghost"
                :aria-label="t('ui.openFor', { p0: storagePageLabel(entry.name), p1: resourceName(entry.name) })"
                @click="emit('navigate', storagePages[entry.name] ?? 'settings')"
              />
            </AppTooltip>
          </dd>
        </div>
      </dl>
      <p class="panel-body text-xs muted">
        {{ t("ui.logicalFileSizesInManagedFoldersCustomData") }}
      </p>
    </section>
    <p v-if="!data && !error" class="notice" role="status">{{ t("ui.readingResourceUse") }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  </template>
  <AppDialog
    :open="Boolean(clearing)"
    :content="confirmationContent"
    :title="
      clearing === 'history'
        ? t('ui.clearMetricsAndRequestHistory2')
        : clearing === 'logs'
          ? t('ui.clearLocalLogs')
          : clearing === 'captures'
            ? t('ui.clearRequestAndResponseCaptures2')
            : t('ui.clearDownloadedArchives')
    "
    :description="
      clearing === 'history'
        ? t('ui.thisPermanentlyRemovesLocalMetricsRequestHistoryAnd')
        : clearing === 'logs'
          ? t('ui.thisPermanentlyRemovesManagedLocalLogFilesConfiguration')
          : clearing === 'captures'
            ? t('ui.thisPermanentlyRemovesSavedRequestInputsHtmlAnd')
            : t('ui.thisRemovesCachedDownloadArchivesTheInstalledBrowser')
    "
    @update:open="if (!$event) clearing = undefined;"
  >
    <template #footer
      ><UButton color="neutral" variant="outline" @click="clearing = undefined">{{ t("ui.cancel") }}</UButton
      ><UButton
        data-confirm-default
        color="error"
        :disabled="
          (desktop.status.running && clearing !== 'downloads') ||
          desktop.busy ||
          (clearing === 'downloads' && downloading)
        "
        @click="clear"
        >{{
          t("ui.clearStorage")
        }}</UButton
      ></template
    >
  </AppDialog>
</template>
<style scoped>
.managed-storage > div {
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto;
}
.storage-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px 32px;
  align-items: center;
  gap: 8px;
}
.storage-actions > .mono {
  text-align: right;
  white-space: nowrap;
}
</style>
