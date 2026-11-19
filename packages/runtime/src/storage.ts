import { lstat, rm } from "node:fs/promises"
import { join } from "node:path"
import { supportedBrowsers } from "./browser-assets"
import { control, lockInstance } from "./control"
import { installAllExclusive, installExclusive } from "./install-lock"
import { type RuntimePaths, runtimePaths } from "./paths"
import { privateDirectory } from "./store"

const targets = {
  logs: ["logs"],
  downloads: ["downloads"],
  captures: ["captures"],
  history: ["captures", "metrics.sqlite-wal", "metrics.sqlite-shm", "metrics.sqlite"],
} as const

export async function clearManagedStorage(kind: string, paths: RuntimePaths = runtimePaths()) {
  if (!Object.hasOwn(targets, kind)) throw new Error("Unknown managed storage category")
  await privateDirectory(paths.home)
  await privateDirectory(paths.run)
  const clear = () =>
    installExclusive(paths.browser, async (check) => {
      if (kind !== "downloads" && (await control("status", paths)))
        throw new Error("Stop the local server before clearing managed storage")
      const release = kind === "downloads" ? undefined : await lockInstance(paths)
      try {
        const entries = targets[kind as keyof typeof targets].map((name) => join(paths.home, name))
        // Refuse redirected roots; rm does not follow links inside a managed directory.
        for (const path of entries) {
          const info = await lstat(path).catch((error) => {
            if (error.code !== "ENOENT") throw error
          })
          if (info?.isSymbolicLink()) throw new Error("Managed storage must not be a symbolic link")
        }
        for (const path of entries) {
          check()
          await rm(path, { recursive: true, force: true })
        }
        return { cleared: kind }
      } finally {
        await release?.()
      }
    })
  if (kind !== "downloads") return clear()
  await privateDirectory(join(paths.home, "browsers"))
  const versions = supportedBrowsers.filter((build) => build.assets[`${process.platform}-${process.arch}`])
  return installAllExclusive(
    versions.map((build) => join(paths.home, "browsers", build.version)),
    async (check) => {
      check()
      return clear()
    },
  )
}
