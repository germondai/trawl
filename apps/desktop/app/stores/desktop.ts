import { invoke, isTauri } from "@tauri-apps/api/core"
import {
  type DashboardSnapshot,
  type HealthResponse,
  type InstanceCapabilities,
  Trawl,
  TrawlError,
} from "@trawl/client"
import { emptyConfig, type Setting, settings, type UserConfig } from "@trawl/config/catalog"
import { defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import { createInstanceFetch } from "../utils/instance-fetch"

interface Status {
  running: boolean
  owner?: string
  baseURL?: string
  pid?: number
}
interface BrowserInstallation {
  installed: boolean
  version?: string
  supportedVersion?: string
  state?: "ready" | "not-installed" | "repair-needed" | "update-available" | "unsupported"
  path?: string
  downloadBytes?: number
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
export const useDesktopStore = defineStore("desktop", () => {
  const native = isTauri()
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
  const settingsDirty = shallowRef(false)
  const error = shallowRef("")
  const metricError = shallowRef("")
  const activeId = shallowRef("local")
  const active = computed(() =>
    activeId.value === "local"
      ? {
          id: "local",
          name: "Local instance",
          baseURL: status.value.baseURL || `http://127.0.0.1:${effective.value.PORT || "8191"}`,
        }
      : config.value.desktop.connections.find(({ id }) => id === activeId.value),
  )
  async function management<T>(request: Record<string, unknown>): Promise<T> {
    if (!native) throw new Error("Open the native TRAWL application to manage this device")
    return invoke<T>("management", { request })
  }
  async function bootstrap() {
    if (!native) return
    const data = await management<Bootstrap>({ action: "bootstrap" })
    config.value = data.config
    effective.value = data.effective
    inherited.value = data.inherited
    sources.value = data.sources
    catalog.value = data.catalog
    status.value = data.status
    browser.value = data.browser
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
    if (!native || (!force && busy.value) || refreshing === activeId.value) return
    const id = activeId.value
    const serial = ++generation
    refreshing = id
    const current = () => serial === generation && id === activeId.value
    try {
      if (id === "local") {
        const value = await invoke<Status>("instance_status")
        if (!current()) return
        status.value = value
        if (!value.running) {
          health.value = undefined
          metrics.value = undefined
          capabilities.value = undefined
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
      error.value = cause instanceof Error ? cause.message : "Operation failed"
      return false
    } finally {
      busy.value = false
    }
  }
  const start = () => action(() => invoke("server_start"))
  const stop = () => action(() => management({ action: "stop" }))
  const install = () => action(() => management({ action: "installBrowser" }))
  const save = (value: UserConfig) => action(() => management({ action: "saveConfig", config: value }))
  async function select(id: string) {
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
    management,
    client,
    bootstrap,
    refresh,
    action,
    start,
    stop,
    install,
    save,
    select,
  }
})
