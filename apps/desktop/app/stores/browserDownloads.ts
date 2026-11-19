import { Channel, invoke } from "@tauri-apps/api/core"
import { defineStore } from "pinia"
import { computed } from "vue"
import { createBrowserDownloads } from "../utils/browser-downloads"
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
          toast.add({ title: "Download stopped; cleanup needs attention", description: String(error), color: "error" })
        throw error
      } finally {
        signal.removeEventListener("abort", cancel)
      }
    },
    (job) => {
      if (job.state === "done")
        toast.add({
          title: `Camoufox ${job.version} is ready`,
          description:
            job.action === "repairBrowser" &&
            desktop.browser.choices?.find((choice) => choice.version === job.version)?.pending
              ? "The repair is ready to apply from Browser installations."
              : "The browser is available in Browser installations.",
          color: "success",
        })
      else if (job.state === "error")
        toast.add({ title: `Could not install Camoufox ${job.version}`, description: job.error, color: "error" })
    },
    (job) => desktop.management({ action: "discardBrowserDownload", browserVersion: job.version }),
  )
  const start = async (...args: Parameters<typeof downloads.start>) => {
    try {
      if (desktop.native) await invoke("enable_notifications").catch(() => {})
      await downloads.start(...args)
    } catch (error) {
      toast.add({ title: "Could not start download", description: String(error), color: "error" })
    }
  }
  const pending = computed(() =>
    Object.values(downloads.jobs.value).filter((job) => ["queued", "running", "cancelling"].includes(job.state)),
  )
  return { ...downloads, start, pending }
})
