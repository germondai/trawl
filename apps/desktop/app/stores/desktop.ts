import { invoke, isTauri } from "@tauri-apps/api/core"
import {
  type DashboardSnapshot,
  type HealthResponse,
  type InstanceCapabilities,
  Trawl,
  TrawlError,
} from "@trawl/client"
import { emptyConfig, orderedInstanceIds, type Setting, settings, type UserConfig } from "@trawl/config/catalog"
import { defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import { mergeConfigChanges } from "../utils/config-changes"
import { createInstanceFetch } from "../utils/instance-fetch"

interface Status {
  running: boolean
  ready?: boolean
  owner?: string
  baseURL?: string
  pid?: number
}
export interface BrowserInstallation {
  system?: boolean
  installed: boolean
  version?: string
  supportedVersion?: string
  state?: "ready" | "not-installed" | "repair-needed" | "update-available" | "unsupported"
  path?: string
  downloadBytes?: number
  inventoryLimited?: boolean
  choices?: {
    id?: string
    supported?: boolean
    present?: boolean
    latest?: boolean
    recommended?: boolean
    deprecated?: boolean
    nightly?: boolean
    engine: string
    name: string
    version: string
    downloadBytes: number
    installed?: boolean
    active?: boolean
    pending?: boolean
    state?: string
    path?: string
  }[]
}
interface Bootstrap {
  startupError?: string
  config: UserConfig
  inherited: Record<string, string>
  effective: Record<string, string>
  sources: Record<string, string>
  catalog: Setting[]
  status: Status
  browser: BrowserInstallation
}
export interface InstallationProgress {
  phase: string
  completed?: number
  total?: number
  unit?: "bytes" | "files"
  elapsedMs: number
  etaMs?: number
}
export const useDesktopStore = defineStore("desktop", () => {
  const native = isTauri()
  const mobile = native && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
  const loaded = shallowRef(false)
  const config = ref<UserConfig>(emptyConfig())
  const effective = ref<Record<string, string>>({})
  const inherited = ref<Record<string, string>>({})
  const sources = ref<Record<string, string>>({})
  const catalog = shallowRef<readonly Setting[]>(settings)
  const status = shallowRef<Status>({ running: false })
  const browser = shallowRef<BrowserInstallation>({ installed: false })
  const metrics = shallowRef<DashboardSnapshot>()
  const health = shallowRef<HealthResponse>()
  const capabilities = shallowRef<InstanceCapabilities | null>()
  const busy = shallowRef(false)
  let configRevision = 0
  let configWrites: Promise<unknown> = Promise.resolve()
  let operationSerial = 0
  let browserRevision = 0
  const settingsDirty = shallowRef(false)
  const error = shallowRef("")
  const metricError = shallowRef("")
  const activeId = shallowRef("local")
  const instances = computed(() => {
    const local = {
      id: "local",
      name: config.value.desktop.localName || "Local instance",
      baseURL: status.value.baseURL || `http://127.0.0.1:${effective.value.PORT || "8191"}`,
    }
    const profiles = new Map([local, ...config.value.desktop.connections].map((profile) => [profile.id, profile]))
    return orderedInstanceIds(config.value.desktop).map((id) => profiles.get(id)!)
  })
  const active = computed(() => instances.value.find(({ id }) => id === activeId.value))
  async function management<T>(request: Record<string, unknown>): Promise<T> {
    if (!native) throw new Error("Open the native TRAWL application to manage this device")
    return invoke<T>("management", { request })
  }
  async function bootstrap() {
    if (!native) return
    const serial = operationSerial
    const configSerial = configRevision
    const browserSerial = ++browserRevision
    const data = await management<Bootstrap>({ action: "bootstrap" })
    if (serial !== operationSerial) return
    if (configSerial === configRevision) {
      config.value = data.config
      effective.value = data.effective
      inherited.value = data.inherited
      sources.value = data.sources
    }
    catalog.value = data.catalog
    status.value = data.status
    if (browserSerial === browserRevision) browser.value = data.browser
    loaded.value = true
    if (data.startupError) error.value = data.startupError
  }
  function client(observeId?: import("~/utils/instance-fetch").ObserveRequestId): Trawl {
    const instance = active.value
    if (!instance) throw new Error("Select a connection first")
    return new Trawl({
      baseURL: instance.baseURL,
      timeoutMs: 15000,
      fetch: createInstanceFetch(instance.id, instance.baseURL, observeId),
    })
  }

  let capabilityCheckedAt = 0
  let refreshing: string | undefined
  let generation = 0
  async function refresh(force = false) {
    if (!native || (!force && busy.value) || (!force && refreshing === activeId.value)) return
    const id = activeId.value
    const serial = ++generation
    refreshing = id
    const current = () => serial === generation && id === activeId.value
    try {
      if (id === "local") {
        const value = await invoke<Status>("instance_status")
        if (!current()) return
        status.value = value
        if (!value.running || value.ready === false) {
          health.value = undefined
          metrics.value = undefined
          capabilities.value = undefined
          if (value.running) error.value = ""
          return
        }
      }
      const api = client()
      const nextHealth = await api.health()
      if (!current()) return
      health.value = nextHealth
      if (capabilities.value === undefined || force || Date.now() - capabilityCheckedAt >= 30_000) {
        capabilityCheckedAt = Date.now()
        try {
          const next = await api.capabilities()
          if (!current()) return
          capabilities.value = next
        } catch (cause) {
          if (!current()) return
          capabilities.value =
            cause instanceof TrawlError && (cause.kind === "protocol" || cause.status === 404) ? null : undefined
        }
      }
      try {
        const nextMetrics = await api.metrics(60)
        if (!current()) return
        metrics.value = nextMetrics
        metricError.value = ""
      } catch {
        if (!current()) return
        metrics.value = undefined
        metricError.value = "Metrics are unavailable. Enable the dashboard on this instance and check its access token."
      }
      error.value = ""
    } catch (cause) {
      if (!current()) return
      health.value = undefined
      metrics.value = undefined
      error.value = cause instanceof Error ? cause.message : "Cannot connect to this instance"
    } finally {
      if (serial === generation) refreshing = undefined
    }
  }
  async function action(operation: () => Promise<unknown>) {
    operationSerial++
    generation++
    refreshing = undefined
    busy.value = true
    error.value = ""
    try {
      await operation()
      await bootstrap()
      await refresh(true)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Operation failed"
      return false
    } finally {
      busy.value = false
    }
  }
  const start = () => action(() => invoke("server_start"))
  const stop = () => action(() => management({ action: "stop" }))
  async function refreshBrowser() {
    const revision = ++browserRevision
    const next = await management<BrowserInstallation>({ action: "browserStatus" })
    if (revision === browserRevision) browser.value = next
  }
  const install = () => useBrowserDownloadsStore().start(browser.value.supportedVersion ?? "152.0.4-beta.30")
  function enqueueConfig(write: () => Promise<boolean>) {
    const pending = configWrites.then(write, write)
    configWrites = pending.catch(() => {})
    return pending
  }
  function snapshot(value: UserConfig): UserConfig {
    return JSON.parse(JSON.stringify(value))
  }
  const save = (value: UserConfig) => {
    const baseline = snapshot(config.value),
      draft = snapshot(value)
    return enqueueConfig(() =>
      action(async () => {
        configRevision++
        const next = await management<UserConfig>({
          action: "saveConfig",
          config: mergeConfigChanges(baseline, draft, config.value),
        })
        configRevision++
        config.value = next
      }),
    )
  }
  function reorderInstance(id: string, direction: -1 | 1) {
    return enqueueConfig(async () => {
      const next = snapshot(config.value)
      const order = orderedInstanceIds(next.desktop),
        index = order.indexOf(id),
        target = index + direction
      if (index < 0 || target < 0 || target >= order.length) return false
      ;[order[index], order[target]] = [order[target]!, order[index]!]
      next.desktop.instanceOrder = order
      configRevision++
      try {
        const saved = await management<UserConfig>({ action: "saveConfig", config: next })
        configRevision++
        config.value = saved
        return true
      } catch (cause) {
        configRevision++
        error.value = String(cause)
        return false
      }
    })
  }
  async function select(id: string) {
    if (native) await invoke("tray_instance", { id })
    generation++
    refreshing = undefined
    activeId.value = id
    capabilities.value = undefined
    metrics.value = undefined
    health.value = undefined
    error.value = ""
    metricError.value = ""
    await refresh()
  }
  return {
    native,
    mobile,
    loaded,
    config,
    effective,
    inherited,
    sources,
    catalog,
    status,
    browser,
    metrics,
    health,
    capabilities,
    busy,
    settingsDirty,
    error,
    metricError,
    activeId,
    active,
    instances,
    management,
    client,
    bootstrap,
    refreshBrowser,
    refresh,
    action,
    start,
    stop,
    install,
    save,
    reorderInstance,
    select,
  }
})
