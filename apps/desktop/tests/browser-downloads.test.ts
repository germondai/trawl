import { expect, test } from "bun:test"
import { createBrowserDownloads } from "../app/utils/browser-downloads"

test("download state survives independent views, retains progress and cancels only its own task", async () => {
  const running = new Map<string, { resolve: () => void; progress: (value: any) => void; signal: AbortSignal }>()
  const notifications: string[] = []
  const downloads = createBrowserDownloads(
    (job, progress, signal) =>
      new Promise<void>((resolve, reject) => {
        running.set(job.version, { resolve, progress, signal })
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      }),
    (job) => notifications.push(`${job.version}:${job.state}`),
  )
  const first = downloads.start("first"),
    second = downloads.start("second")
  expect(Object.keys(downloads.jobs.value)).toEqual(["first", "second"])
  running.get("first")!.progress({ phase: "download", completed: 20, total: 100, elapsedMs: 1000, etaMs: 4000 })
  expect(downloads.jobs.value.first?.progress.etaMs).toBe(4000)
  downloads.cancel("first")
  await first
  expect(downloads.jobs.value.first?.state).toBe("cancelled")
  expect(running.get("second")!.signal.aborted).toBe(false)
  running.get("second")!.resolve()
  await second
  expect(downloads.jobs.value.second?.state).toBe("done")
  expect(notifications).toEqual(["first:cancelled", "second:done"])
})

test("completion after the commit wins over a late cancellation and failed jobs can retry", async () => {
  let resolve!: () => void
  const finished: string[] = []
  const downloads = createBrowserDownloads(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
    (job) => finished.push(job.state),
  )
  const pending = downloads.start("version")
  downloads.cancel("version")
  resolve()
  await pending
  expect(finished).toEqual(["done"])
  let attempts = 0
  const retry = createBrowserDownloads(
    async () => {
      if (++attempts === 1) throw Error("owned failure")
    },
    () => {},
  )
  await retry.start("version")
  expect(retry.jobs.value.version?.error).toBe("owned failure")
  await retry.start("version")
  expect(retry.jobs.value.version?.state).toBe("done")
})

test("bootstrap and download completion share browser snapshot ordering", async () => {
  const { createPinia, setActivePinia } = await import("pinia")
  const { emptyConfig } = await import("@trawl/config/catalog")
  const { useDesktopStore } = await import("../app/stores/desktop")
  const before = Reflect.get(globalThis, "window")
  const nativeBefore = Reflect.get(globalThis, "isTauri")
  Reflect.set(globalThis, "isTauri", true)
  const pending: { request: any; resolve: (value: any) => void }[] = []
  Reflect.set(globalThis, "window", {
    __TAURI_INTERNALS__: {
      invoke: (_: string, args: any) => new Promise((resolve) => pending.push({ request: args.request, resolve })),
    },
  })
  setActivePinia(createPinia())
  try {
    const desktop = useDesktopStore()
    const bootstrap = (browser: any) => ({
      config: emptyConfig(),
      inherited: {},
      effective: {},
      sources: {},
      catalog: [],
      status: { running: false },
      browser,
    })
    const first = desktop.bootstrap()
    const second = desktop.refreshBrowser()
    pending[1]!.resolve({ installed: true, version: "new" })
    await second
    pending[0]!.resolve(bootstrap({ installed: false }))
    await first
    expect(desktop.browser).toMatchObject({ installed: true, version: "new" })
    const stale = desktop.refreshBrowser()
    const current = desktop.bootstrap()
    pending[3]!.resolve(bootstrap({ installed: true, version: "activated" }))
    await current
    pending[2]!.resolve({ installed: false })
    await stale
    expect(desktop.browser.version).toBe("activated")
  } finally {
    Reflect.set(globalThis, "window", before)
    Reflect.set(globalThis, "isTauri", nativeBefore)
  }
})

test("late progress from a previous attempt cannot change its replacement", async () => {
  const attempts: { progress: (value: any) => void; resolve: () => void }[] = []
  const downloads = createBrowserDownloads(
    (_, progress) => new Promise<void>((resolve) => attempts.push({ progress, resolve })),
    () => {},
  )
  const first = downloads.start("version")
  attempts[0]!.resolve()
  await first
  const second = downloads.start("version")
  attempts[0]!.progress({ phase: "done", elapsedMs: 0 })
  expect(downloads.jobs.value.version?.progress.phase).toBe("checking")
  attempts[1]!.resolve()
  await second
})

test("the download queue keeps three active slots and skips cancelled waiting entries", async () => {
  const resolvers = new Map<string, () => void>()
  const downloads = createBrowserDownloads(
    (job) => new Promise<void>((resolve) => resolvers.set(job.version, resolve)),
    () => {},
  )
  const all = ["one", "two", "three", "four", "five"].map((version) => downloads.start(version))
  expect(resolvers.size).toBe(3)
  expect(downloads.jobs.value.four?.state).toBe("queued")
  downloads.cancel("four")
  resolvers.get("one")!()
  await all[0]
  expect(resolvers.has("four")).toBe(false)
  expect(downloads.jobs.value.five?.state).toBe("running")
  for (const [version, resolve] of resolvers) if (version !== "one") resolve()
  await Promise.all(all)
})

test("cancelling a queued retry clears retained data before allowing another attempt", async () => {
  const running: (() => void)[] = [],
    cleaned: string[] = []
  let finishCleanup!: () => void
  const downloads = createBrowserDownloads(
    () => new Promise<void>((resolve) => running.push(resolve)),
    () => {},
    async (job) => {
      cleaned.push(job.version)
      await new Promise<void>((resolve) => {
        finishCleanup = resolve
      })
    },
  )
  const active = ["one", "two", "three"].map((version) => downloads.start(version))
  const queued = downloads.start("interrupted")
  downloads.cancel("interrupted")
  expect(cleaned).toEqual(["interrupted"])
  expect(downloads.jobs.value.interrupted?.state).toBe("cancelling")
  await downloads.start("interrupted")
  expect(running).toHaveLength(3)
  finishCleanup()
  await queued
  expect(downloads.jobs.value.interrupted?.state).toBe("cancelled")
  for (const resolve of running) resolve()
  await Promise.all(active)
})
