import { lstat, opendir, rm } from "node:fs/promises"
import { join } from "node:path"
import { browserBuild, supportedBrowsers } from "./browser-assets"
import { installAllExclusive, installExclusive } from "./install-lock"
import type { RuntimePaths } from "./paths"
import { privateDirectory } from "./store"

const lifetime = 24 * 60 * 60 * 1000
export async function discardBrowserDownload(paths: RuntimePaths, version?: string) {
  const build = browserBuild(version),
    asset = build?.assets[`${process.platform}-${process.arch}`]
  if (!build || !asset) throw Error("Unsupported browser build")
  await privateDirectory(join(paths.home, "browsers"))
  return installExclusive(join(paths.home, "browsers", build.version), async (check) => {
    await privateDirectory(join(paths.home, "downloads"))
    for (const suffix of ["", ".partial", ".partial.json"]) {
      check()
      await rm(join(paths.home, "downloads", `${asset.sha256}.zip${suffix}`), { force: true })
    }
    return { discarded: build.version }
  })
}
export async function pruneBrowserDownloads(paths: RuntimePaths) {
  // Cleanup is best effort; an active download always keeps its files and locks.
  try {
    const home = await lstat(paths.home)
    if (!home.isDirectory() || home.isSymbolicLink()) return
    const builds = supportedBrowsers.filter((build) => build.assets[`${process.platform}-${process.arch}`])
    await privateDirectory(join(paths.home, "browsers"))
    await installAllExclusive(
      builds.map((build) => join(paths.home, "browsers", build.version)),
      async (check) =>
        installExclusive(paths.browser, async (globalCheck) => {
          const owned = () => {
            check()
            globalCheck()
          }
          const downloads = join(paths.home, "downloads")
          const info = await lstat(downloads).catch(() => undefined)
          if (info?.isDirectory() && !info.isSymbolicLink()) {
            let count = 0
            for await (const entry of await opendir(downloads)) {
              if (++count > 256) break
              if (!/^[a-f0-9]{64}\.zip(?:\.partial(?:\.json)?|\.[a-f0-9-]{36}\.partial)?$/.test(entry.name)) continue
              const path = join(downloads, entry.name),
                value = await lstat(path)
              if (!value.isFile() || Date.now() - value.mtimeMs < lifetime) continue
              owned()
              await rm(path, { force: true })
            }
          }
          let count = 0,
            removed = 0
          for await (const entry of await opendir(paths.home)) {
            if (++count > 256 || removed >= 4) break
            if (!/^browser\.stage-[a-f0-9-]{36}$/.test(entry.name)) continue
            const path = join(paths.home, entry.name),
              value = await lstat(path)
            if (!value.isDirectory() || value.isSymbolicLink() || Date.now() - value.mtimeMs < lifetime) continue
            owned()
            await rm(path, { recursive: true, force: true })
            removed++
          }
        }),
    )
  } catch {
    /* Busy or inaccessible cache cleanup cannot prevent app startup. */
  }
}
