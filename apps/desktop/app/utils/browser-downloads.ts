import { shallowRef } from "vue"
import type { InstallationProgress } from "../stores/desktop"

export interface BrowserDownload {
  id: string
  version: string
  action: "installBrowser" | "repairBrowser"
  state: "queued" | "running" | "cancelling" | "done" | "cancelled" | "error"
  progress: InstallationProgress
  error?: string
}
type RunDownload = (
  job: BrowserDownload,
  progress: (value: InstallationProgress) => void,
  signal: AbortSignal,
) => Promise<unknown>
export function createBrowserDownloads(
  run: RunDownload,
  notify: (job: BrowserDownload) => void,
  discardQueued?: (job: BrowserDownload) => Promise<unknown>,
) {
  const jobs = shallowRef<Record<string, BrowserDownload>>({})
  const controllers = new Map<string, AbortController>()
  const cleaning = new Set<string>()
  const queue: { job: BrowserDownload; resolve: () => void }[] = []
  function update(version: string, values: Partial<BrowserDownload>) {
    jobs.value = { ...jobs.value, [version]: { ...jobs.value[version]!, ...values } }
  }
  function pump() {
    while (controllers.size < 3 && queue.length) {
      const entry = queue.shift()!
      void execute(entry)
    }
  }
  async function execute(entry: (typeof queue)[number]) {
    const { job } = entry,
      { version } = job
    const controller = new AbortController()
    controllers.set(version, controller)
    update(version, { state: "running" })
    try {
      await run(
        job,
        (progress) => {
          if (
            !controller.signal.aborted &&
            jobs.value[version]?.id === job.id &&
            jobs.value[version]?.state === "running"
          )
            update(version, { progress })
        },
        controller.signal,
      )
      update(version, { state: "done", progress: { phase: "done", elapsedMs: 0 } })
    } catch (error) {
      update(
        version,
        controller.signal.aborted
          ? { state: "cancelled" }
          : { state: "error", error: error instanceof Error ? error.message : String(error) },
      )
    } finally {
      controllers.delete(version)
      try {
        notify(jobs.value[version]!)
      } finally {
        entry.resolve()
        pump()
      }
    }
  }
  function start(version: string, action: BrowserDownload["action"] = "installBrowser") {
    if (controllers.has(version) || cleaning.has(version) || queue.some((entry) => entry.job.version === version))
      return Promise.resolve()
    const job: BrowserDownload = {
      id: crypto.randomUUID(),
      version,
      action,
      state: "queued",
      progress: { phase: "checking", elapsedMs: 0 },
    }
    jobs.value = { ...jobs.value, [version]: job }
    const pending = new Promise<void>((resolve) => queue.push({ job, resolve }))
    pump()
    return pending
  }
  function cancel(version: string) {
    const queued = queue.findIndex((entry) => entry.job.version === version)
    if (queued >= 0) {
      const [entry] = queue.splice(queued, 1)
      if (entry) void cancelQueued(entry)
      return
    }
    const controller = controllers.get(version)
    if (!controller || controller.signal.aborted) return
    update(version, { state: "cancelling" })
    controller.abort()
  }
  async function cancelQueued(entry: (typeof queue)[number]) {
    const { version } = entry.job
    cleaning.add(version)
    update(version, { state: "cancelling" })
    pump()
    try {
      await discardQueued?.(entry.job)
      update(version, { state: "cancelled" })
    } catch (error) {
      update(version, { state: "error", error: `Could not clean cancelled download: ${String(error)}` })
    } finally {
      cleaning.delete(version)
      try {
        notify(jobs.value[version]!)
      } finally {
        entry.resolve()
      }
    }
  }
  return { jobs, start, cancel }
}
