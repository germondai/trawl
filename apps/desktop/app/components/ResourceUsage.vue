<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core"
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"
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
const error = shallowRef("")
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
const storagePageLabel = (name: string) =>
  pages.find((page) => page.id === storagePages[name])?.label ?? "Server settings"
const fileManager = desktop.mobile
  ? "Android app storage settings"
  : /Mac/.test(navigator.platform)
    ? "Finder"
    : /Win/.test(navigator.platform)
      ? "Explorer"
      : "file manager"
const local = computed(() => desktop.activeId === "local")
const memoryMax = computed(() => desktop.health?.memory?.limitBytes || data.value?.hostMemory.totalBytes)
const bytes = (value: number | null | undefined) =>
  value == null
    ? "Not reported"
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GiB`
      : value >= 1024 ** 2
        ? `${(value / 1024 ** 2).toFixed(1)} MiB`
        : value >= 1024
          ? `${(value / 1024).toFixed(1)} KiB`
          : `${value} B`
const cpu = (value: number | null | undefined) => (value == null ? "Sampling…" : `${value.toFixed(1)}%`)
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
    if (!disposed && local.value) error.value = String(cause)
  } finally {
    if (!disposed) loading.value = false
  }
}
async function reveal(name: string) {
  try {
    await invoke("reveal_storage", { name })
  } catch (cause) {
    error.value = String(cause)
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
      Process and disk metrics are available for Local instance. Remote container memory is shown when the instance
      reports it.
    </div>
    <div v-if="desktop.health?.memory" class="panel panel-body">
      <h2>Remote memory</h2>
      <p class="mono mt-4">
        {{ bytes(desktop.health.memory.workingSetBytes ?? desktop.health.memory.currentBytes)
        }}<span class="muted"> / {{ bytes(desktop.health.memory.limitBytes) }} limit</span>
      </p>
    </div>
  </template>
  <template v-else>
    <div v-if="data" class="stats">
      <div class="stat">
        <div class="stat-label">TRAWL process trees · CPU</div>
        <div class="stat-value mono">{{ cpu(data.cpuPercent) }}</div>
        <p class="stat-hint">100% represents one logical CPU</p>
        <MetricBar
          :value="data.cpuPercent"
          :max="data.logicalCpus * 100"
          :label="`${cpu(data.cpuPercent)} of ${data.logicalCpus} logical CPUs`"
        />
      </div>
      <div class="stat">
        <div class="stat-label">Resident memory</div>
        <div class="stat-value mono">{{ bytes(data.memoryBytes) }}</div>
        <p class="stat-hint">
          {{ data.processes.length }} processes · {{ bytes(memoryMax) }}
          {{ desktop.health?.memory?.limitBytes ? "limit" : "device total" }}
        </p>
        <MetricBar
          :value="data.memoryBytes"
          :max="memoryMax"
          :label="`${bytes(data.memoryBytes)} of ${bytes(memoryMax)}`"
        />
      </div>
      <div class="stat">
        <div class="stat-label">Device memory available</div>
        <div class="stat-value mono">{{ bytes(data.hostMemory.availableBytes) }}</div>
        <p class="stat-hint">{{ bytes(data.hostMemory.totalBytes) }} installed</p>
        <MetricBar
          :value="data.hostMemory.availableBytes"
          :max="data.hostMemory.totalBytes"
          :label="`${bytes(data.hostMemory.availableBytes)} available of ${bytes(data.hostMemory.totalBytes)}`"
        />
      </div>
    </div>
    <section v-if="data" class="panel">
      <div class="panel-heading">
        <h2>Processes</h2>
      </div>
      <div class="table-wrap">
        <table class="request-table">
          <thead>
            <tr>
              <th>Process</th>
              <th>PID</th>
              <th>CPU</th>
              <th>Memory</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="process in data.processes" :key="process.pid">
              <td>{{ process.name }}</td>
              <td class="mono">{{ process.pid }}</td>
              <td class="mono">{{ cpu(process.cpuPercent) }}</td>
              <td class="mono">{{ bytes(process.memoryBytes) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="panel-body text-xs muted">
        Includes the desktop, local server and their descendants. Shared resident pages may be counted more than once;
        system-managed WebView helpers may be outside these trees.
      </p>
    </section>
    <section v-if="data" class="panel">
      <div class="panel-heading">
        <h2>Managed storage</h2>
        <span class="text-xs mono muted">{{ storagePartial ? "At least " : "" }}{{ bytes(storageBytes) }} used</span>
      </div>
      <dl class="browser-details managed-storage">
        <div v-for="entry in storageEntries" :key="entry.name">
          <dt>{{ entry.name }}</dt>
          <dd class="storage-actions">
            <span class="mono">{{ entry.partial ? "At least " : "" }}{{ bytes(entry.bytes) }}</span>
            <UTooltip :text="`Show in ${fileManager}`"
              ><UButton
                icon="i-lucide-folder-open"
                class="size-8 justify-center"
                color="neutral"
                variant="ghost"
                :aria-label="`Show ${entry.name} in ${fileManager}`"
                :disabled="!desktop.native"
                @click="reveal(entry.location)"
              /></UTooltip
            >
            <UTooltip
              v-if="clearable[entry.name]"
              :text="
                desktop.status.running && clearable[entry.name] !== 'downloads'
                  ? 'Stop the local server to clear storage'
                  : clearable[entry.name] === 'history'
                    ? 'Clear metrics and request history'
                    : clearable[entry.name] === 'captures'
                      ? 'Clear request and response captures'
                      : `Clear ${entry.name.toLowerCase()}`
              "
              ><span
                ><UButton
                  icon="i-lucide-trash-2"
                  class="size-8 justify-center"
                  color="neutral"
                  variant="ghost"
                  :aria-label="
                    clearable[entry.name] === 'history'
                      ? 'Clear metrics and request history'
                      : clearable[entry.name] === 'captures'
                        ? 'Clear request and response captures'
                        : `Clear ${entry.name.toLowerCase()}`
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
              ></UTooltip
            >
            <UTooltip v-else :text="`Open ${storagePageLabel(entry.name)}`">
              <UButton
                icon="i-lucide-arrow-up-right"
                class="size-8 justify-center"
                color="neutral"
                variant="ghost"
                :aria-label="`Open ${storagePageLabel(entry.name)} for ${entry.name}`"
                @click="emit('navigate', storagePages[entry.name] ?? 'settings')"
              />
            </UTooltip>
          </dd>
        </div>
      </dl>
      <p class="panel-body text-xs muted">
        Logical file sizes in managed folders. Custom data paths are excluded. A bounded scan may show a lower bound for
        large or unreadable directories.
      </p>
    </section>
    <p v-if="!data && !error" class="notice" role="status">Reading resource use…</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  </template>
  <UModal
    :open="Boolean(clearing)"
    :content="confirmationContent"
    :title="
      clearing === 'history'
        ? 'Clear metrics and request history?'
        : clearing === 'logs'
          ? 'Clear local logs?'
          : clearing === 'captures'
            ? 'Clear request and response captures?'
            : 'Clear downloaded archives?'
    "
    :description="
      clearing === 'history'
        ? 'This permanently removes local metrics, request history and saved request/response captures. Configuration and the installed browser are kept.'
        : clearing === 'logs'
          ? 'This permanently removes managed local log files. Configuration and request history are kept.'
          : clearing === 'captures'
            ? 'This permanently removes saved request inputs, HTML and screenshots with their capture index. Metrics, request history and configuration are kept.'
            : 'This removes cached download archives. The installed browser and bundled runtime are kept.'
    "
    @update:open="if (!$event) clearing = undefined;"
  >
    <template #footer
      ><UButton color="neutral" variant="outline" @click="clearing = undefined">Cancel</UButton
      ><UButton
        data-confirm-default
        color="error"
        :disabled="
          (desktop.status.running && clearing !== 'downloads') ||
          desktop.busy ||
          (clearing === 'downloads' && downloading)
        "
        @click="clear"
        >Clear storage</UButton
      ></template
    >
  </UModal>
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
@media (max-width: 720px) {
  .managed-storage > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
