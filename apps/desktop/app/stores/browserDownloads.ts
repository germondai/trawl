import { Channel, invoke } from "@tauri-apps/api/core"
import { defineStore } from "pinia"
import { computed } from "vue"
import { createBrowserDownloads } from "../utils/browser-downloads"
import { nativeErrorMessage, t } from "../utils/localization"
import type { InstallationProgress } from "./desktop"

export const useBrowserDownloadsStore = defineStore("browserDownloads", () => {
  const desktop = useDesktopStore()
  const toast = useToast()
  const downloads = createBrowserDownloads(
    async (job, progress, signal) => {
      const cancel = () => {
        void invoke("browser_operation_cancel", { operationId: job.id }).catch(() => {})
      }
      const channel = new Channel<InstallationProgress>()
      channel.onmessage = (value) => {
        if (signal.aborted) cancel()
        else progress(value)
      }
      signal.addEventListener("abort", cancel, { once: true })
      try {
        await invoke("browser_operation", {
          operationId: job.id,
          request: { action: job.action, browserVersion: job.version },
          onProgress: channel,
        })
        await desktop.refreshBrowser().catch(() => {})
      } catch (error) {
        if (String(error).startsWith("Could not clean cancelled download:"))
          toast.add({
            title: t("ui.downloadStoppedCleanupNeedsAttention"),
            description: nativeErrorMessage(error),
            color: "error",
          })
        throw error
      } finally {
        signal.removeEventListener("abort", cancel)
      }
    },
    (job) => {
      if (job.state === "done")
        toast.add({
          title: t("ui.camoufoxIsReady", { p0: job.version }),
          description:
            job.action === "repairBrowser" &&
            desktop.browser.choices?.find((choice) => choice.version === job.version)?.pending
              ? t("ui.theRepairIsReadyToApplyFromBrowser")
              : t("ui.theBrowserIsAvailableInBrowserInstallations"),
          color: "success",
        })
      else if (job.state === "error")
        toast.add({
          title: t("ui.couldNotInstallCamoufox", { p0: job.version }),
          description: nativeErrorMessage(job.error),
          color: "error",
        })
    },
    (job) => desktop.management({ action: "discardBrowserDownload", browserVersion: job.version }),
  )
  const start = async (...args: Parameters<typeof downloads.start>) => {
    try {
      if (desktop.native) await invoke("enable_notifications").catch(() => {})
      await downloads.start(...args)
    } catch (error) {
      toast.add({ title: t("ui.couldNotStartDownload"), description: nativeErrorMessage(error), color: "error" })
    }
  }
  const pending = computed(() =>
    Object.values(downloads.jobs.value).filter((job) => ["queued", "running", "cancelling"].includes(job.state)),
  )
  return { ...downloads, start, pending }
})
