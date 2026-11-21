import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { computed } from "vue"
import { version } from "../../package.json"
import { LocalizedError, nativeErrorMessage, t } from "../utils/localization"

interface Release {
  state: "available" | "current" | "unpublished"
  current: string
  version?: string
  notes?: string
}
interface Progress {
  state: "idle" | "downloading" | "installing" | "ready" | "permission" | "failed"
  downloaded?: number
  total?: number
}

export const useAppUpdates = createSharedComposable(() => {
  const instance = useDesktopStore()
  const current = shallowRef(version)
  const result = shallowRef<Release>()
  const progress = shallowRef<Progress>({ state: "idle" })
  const checking = shallowRef(false)
  const failure = shallowRef<unknown>("")
  const error = computed(() => nativeErrorMessage(failure.value))
  const automatic = useLocalStorage("trawl-check-updates", true)
  const lastCheck = useLocalStorage("trawl-last-update-check", 0)
  const percentage = computed(() =>
    progress.value.total && progress.value.total > 0
      ? Math.min(100, ((progress.value.downloaded ?? 0) / progress.value.total) * 100)
      : undefined,
  )
  const installing = computed(() => ["downloading", "installing"].includes(progress.value.state))
  let unlisten: UnlistenFn | undefined
  let started = false
  const { pause, resume } = useIntervalFn(
    async () => {
      if (!instance.mobile) return
      try {
        const next = await invoke<Progress>("app_update_download_status")
        progress.value = next
        if (next.state !== "downloading") {
          pause()
          if (next.state === "ready")
            useToast().add({
              title: t("ui.trawlUpdateDownloaded"),
              description: t("ui.openAppSettingsToInstallTheVerifiedApk"),
              color: "success",
            })
          if (next.state === "failed") failure.value = new LocalizedError("ui.theUpdateDownloadFailedCheckForUpdatesTo")
        }
      } catch (cause) {
        failure.value = cause
        pause()
      }
    },
    1500,
    { immediate: false },
  )
  async function check() {
    if (!instance.native || checking.value || installing.value) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    checking.value = true
    failure.value = ""
    try {
      result.value = await Promise.race([
        invoke<Release>("check_app_update"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new LocalizedError("ui.updateCheckTimedOutTryAgainWhenYour")), 12000)
        }),
      ])
      lastCheck.value = Date.now()
    } catch (cause) {
      failure.value = cause
    } finally {
      clearTimeout(timeout)
      checking.value = false
    }
  }
  async function install() {
    if (installing.value) return
    failure.value = ""
    try {
      if (!instance.mobile) progress.value = { state: "downloading" }
      progress.value = await invoke<Progress>("install_app_update")
      if (progress.value.state === "permission") progress.value = { state: "ready" }
      if (instance.mobile && progress.value.state === "downloading") resume()
    } catch (cause) {
      failure.value = cause
      progress.value = { state: "idle" }
    }
  }
  async function start() {
    if (started || !instance.native) return
    started = true
    current.value = await getVersion().catch(() => version)
    unlisten = await listen<Progress>("app-update-progress", ({ payload }) => {
      progress.value = payload
    })
    if (instance.mobile) {
      progress.value = await invoke<Progress>("app_update_download_status")
      if (progress.value.state === "downloading") resume()
    }
    if (automatic.value && Date.now() - lastCheck.value > 24 * 60 * 60 * 1000) await check()
  }
  onScopeDispose(() => {
    pause()
    unlisten?.()
  })
  return { current, result, progress, checking, installing, error, automatic, percentage, check, install, start }
})
