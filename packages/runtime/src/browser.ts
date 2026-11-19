import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, copyFile, cp, lstat, opendir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import AdmZip from "adm-zip"
import { ensureModel, MODEL_PIN } from "fpgen-js"
import revocations from "../../browser/security/emudhra-onecrl.json"
import { digestFile, diskPreflight, downloadVerified, extractVerifiedZip, replaceDirectory } from "./assets"
import {
  browserAssets,
  browserBuild,
  browserBuildLabels,
  browserVersion,
  geoipAsset,
  supportedBrowsers,
  uboAsset,
} from "./browser-assets"
import { control, lockInstance } from "./control"
import { installExclusive } from "./install-lock"
import { type RuntimePaths, runtimePaths } from "./paths"
import type { ProgressReporter } from "./progress"
import { atomicJson, privateDirectory } from "./store"

export function browserRoot(directory: string) {
  return process.platform === "darwin" ? join(directory, "Camoufox.app", "Contents", "Resources") : directory
}
export function browserExecutable(directory: string) {
  return process.platform === "darwin"
    ? join(directory, "Camoufox.app", "Contents", "MacOS", "camoufox")
    : join(directory, process.platform === "win32" ? "camoufox.exe" : "camoufox-bin")
}
export interface BrowserStatus {
  installed: boolean
  state: "ready" | "not-installed" | "repair-needed" | "update-available" | "unsupported"
  supportedVersion: string
  version?: string
  path: string
  downloadBytes?: number
  inventoryLimited?: boolean
  choices: {
    id: string
    supported: boolean
    present: boolean
    latest: boolean
    recommended: boolean
    deprecated: boolean
    nightly: boolean
    engine: string
    name: string
    version: string
    downloadBytes: number
    installed: boolean
    active: boolean
    state: string
    pending: boolean
    path: string
  }[]
}
async function sourceVersion(directory: string) {
  if (!directory || !isAbsolute(directory)) throw new Error("Choose an absolute browser directory")
  const versionFile = join(directory, "version.json")
  const metadata = await lstat(versionFile)
  if (!metadata.isFile() || metadata.size > 8192) throw new Error("Invalid browser version metadata")
  const value = JSON.parse(await readFile(versionFile, "utf8"))
  const version = `${value.version}-${value.build ?? value.release}`
  const build = supportedBrowsers.find(
    (build) => build.version === version && build.assets[`${process.platform}-${process.arch}`],
  )
  if (!build) throw new Error("This browser build is not supported on this platform")
  const executable = await stat(browserExecutable(directory))
  if (!executable.isFile() || executable.size === 0) throw new Error("Browser executable was not found")
  return build
}
export async function browserStatus(paths = runtimePaths()): Promise<BrowserStatus> {
  const asset = browserAssets[`${process.platform}-${process.arch}`]
  const result: BrowserStatus = {
    installed: false,
    state: asset ? "not-installed" : "unsupported",
    supportedVersion: browserVersion,
    path: paths.browser,
    downloadBytes: asset?.size,
    choices: supportedBrowsers.flatMap((browser) => {
      const asset = browser.assets[`${process.platform}-${process.arch}`]
      return asset
        ? [
            {
              id: `stored:${browser.version}`,
              supported: true,
              present: false,
              ...browserBuildLabels(browser.version),
              engine: browser.engine,
              name: browser.name,
              version: browser.version,
              downloadBytes: asset.size,
              installed: false,
              active: false,
              state: "not-installed",
              pending: false,
              path: browserSlot(paths, browser.version),
            },
          ]
        : []
    }),
  }
  const active = await inspectBrowser(paths.browser)
  result.choices = await Promise.all(
    result.choices.map(async (choice) => {
      const isActive = active.version === choice.version
      const directory = isActive ? paths.browser : browserSlot(paths, choice.version)
      const cached = await inspectBrowser(browserSlot(paths, choice.version))
      const status = isActive ? active : cached
      return {
        ...choice,
        ...browserBuildLabels(status.version ?? choice.version),
        ...(status.version && status.version !== choice.version ? { latest: false, recommended: false } : {}),
        version: status.version ?? choice.version,
        id: isActive ? "active" : choice.id,
        present: status.state !== "not-installed",
        supported: !status.version || status.version === choice.version,
        installed: status.installed && status.version === choice.version,
        active: isActive,
        pending: isActive && cached.installed && cached.version === choice.version,
        state: status.version && status.version !== choice.version ? "update-available" : status.state,
        path: directory,
      }
    }),
  )
  if (active.state !== "not-installed" && !result.choices.some((choice) => choice.active))
    result.choices.push(unrecognizedChoice("active", paths.browser, active))
  const library = join(paths.home, "browsers")
  const libraryInfo = await lstat(library).catch(() => undefined)
  if (libraryInfo?.isDirectory() && !libraryInfo.isSymbolicLink()) {
    let count = 0
    for await (const entry of await opendir(library)) {
      if (++count > 128) {
        result.inventoryLimited = true
        break
      }
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        entry.name.endsWith(".lock") ||
        result.choices.some((choice) => choice.id === `stored:${entry.name}`)
      )
        continue
      const directory = join(library, entry.name)
      const status = await inspectBrowser(directory)
      if (status.installed && status.version === entry.name) continue // Prepared repair is already represented by its active row.
      result.choices.push(unrecognizedChoice(`stored:${entry.name}`, directory, status))
    }
  }
  return { ...result, ...active }
}
function unrecognizedChoice(id: string, path: string, status: Awaited<ReturnType<typeof inspectBrowser>>) {
  return {
    id,
    path,
    supported: false,
    present: true,
    ...browserBuildLabels(status.version ?? ""),
    latest: false,
    recommended: false,
    installed: false,
    active: id === "active",
    pending: false,
    engine: "unknown",
    name: status.version ? "Camoufox Firefox" : "Unrecognized browser",
    version: status.version ?? (id === "active" ? "Unknown version" : id.slice(7)),
    downloadBytes: 0,
    state: status.version ? "update-available" : "unknown",
  }
}
function browserSlot(paths: RuntimePaths, version: string) {
  if (!browserBuild(version)?.assets[`${process.platform}-${process.arch}`])
    throw new Error("Unsupported browser build")
  return join(paths.home, "browsers", version)
}
async function inspectBrowser(directory: string) {
  const result: Pick<BrowserStatus, "installed" | "state" | "version"> = { installed: false, state: "not-installed" }
  try {
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      return { ...result, state: "repair-needed" as const }
    result.state = "repair-needed"
    const marker = join(directory, "trawl-browser.json")
    const metadata = await lstat(marker)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8192) return result
    const state = JSON.parse(await readFile(marker, "utf8"))
    if (typeof state.version === "string" && state.version.length < 80) result.version = state.version
    if (!result.version) return result
    if (
      !supportedBrowsers.some(
        (browser) => browser.version === state.version && browser.assets[`${process.platform}-${process.arch}`],
      )
    ) {
      result.state = "update-available"
      return result
    }
    const executable = await stat(browserExecutable(directory))
    if (!executable.isFile() || executable.size === 0) return result
    await access(browserExecutable(directory))
    for (const name of [
      join(directory, "GeoLite2-City.mmdb"),
      join(browserRoot(directory), "addons/UBO/manifest.json"),
      join(directory, "version.json"),
    ])
      if (!(await stat(name)).isFile() || (await stat(name)).size === 0) return result
    if (state.platform !== process.platform || state.arch !== process.arch || state.securityBackport !== true)
      return result
    if (browserBuild(state.version)?.launcher === "official") {
      const model = join(directory, "fpgen")
      for (const file of [...MODEL_PIN.files, "values.dat", ".pinned-model"]) {
        const info = await lstat(join(model, file))
        if (!info.isFile() || !info.size || info.size > 256 * 1024 ** 2) return result
      }
      const stamp = join(model, ".pinned-model")
      if ((await stat(stamp)).size > 128 || (await readFile(stamp, "utf8")).trim() !== MODEL_PIN.sha256) return result
    }
    return { ...result, installed: true, state: "ready" as const }
  } catch {
    return result
  }
}
async function withStoppedServer<T>(paths: RuntimePaths, action: () => Promise<T>): Promise<T> {
  if (await control("status", paths)) throw new Error("Stop the managed server before changing its browser")
  await privateDirectory(paths.run)
  const release = await lockInstance(paths)
  try {
    return await action()
  } finally {
    await release()
  }
}
export async function uninstallBrowser(
  paths = runtimePaths(),
  progress?: ProgressReporter,
  version?: string,
  browserId?: string,
) {
  let explicitTarget: string | undefined
  if (browserId !== undefined) {
    if (browserId === "active") explicitTarget = paths.browser
    else {
      const name = browserId.startsWith("stored:") ? browserId.slice(7) : ""
      if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 255 || /[\\/\r\n\0:]/.test(name))
        throw new Error("Invalid managed browser ID")
      explicitTarget = join(paths.home, "browsers", name)
    }
  }
  return installExclusive(paths.browser, async (check) => {
    progress?.({ phase: "remove" })
    const active = await inspectBrowser(paths.browser)
    const target =
      explicitTarget ??
      (version ? (active.version === version ? paths.browser : browserSlot(paths, version)) : paths.browser)
    const targets = [target]
    if (
      target === paths.browser &&
      active.version &&
      browserBuild(active.version)?.assets[`${process.platform}-${process.arch}`]
    ) {
      const cached = browserSlot(paths, active.version)
      if ((await inspectBrowser(cached)).version === active.version) targets.push(cached)
    }
    const moved: { target: string; removed: string }[] = []
    await withStoppedServer(paths, async () => {
      await privateDirectory(join(paths.home, "browsers"))
      const info = await lstat(target).catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
      if (info && !info.isDirectory() && !info.isSymbolicLink()) throw new Error("Not a managed browser directory")
      check()
      try {
        for (const target of targets) {
          const removed = `${target}.remove-${randomUUID()}`
          try {
            await rename(target, removed)
            moved.push({ target, removed })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
      } catch (error) {
        for (const item of moved.reverse()) await rename(item.removed, item.target)
        throw error
      }
    })
    const removed = moved.map((item) => item.removed)
    if (progress) {
      const entries: { path: string; directory: boolean }[] = []
      const pending = [...removed]
      let bounded = true
      let pathBytes = removed.reduce((sum, path) => sum + path.length * 2, 0)
      while (pending.length && bounded) {
        const path = pending.pop()
        if (!path) break
        const info = await lstat(path).catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        })
        if (!info) continue
        const directory = info.isDirectory() && !info.isSymbolicLink()
        entries.push({ path, directory })
        if (directory)
          for await (const child of await opendir(path)) {
            const name = join(path, child.name)
            pending.push(name)
            pathBytes += name.length * 2
            if (entries.length + pending.length > 100000 || pathBytes > 16 * 1024 * 1024) {
              bounded = false
              break
            }
          }
        bounded = bounded && entries.length + pending.length <= 100000
      }
      if (bounded) {
        let completed = 0
        progress({ phase: "remove", completed, total: entries.length, unit: "files" })
        for (const entry of entries.reverse()) {
          if (entry.directory) await rmdir(entry.path)
          else await rm(entry.path, { force: true })
          progress({ phase: "remove", completed: ++completed, total: entries.length, unit: "files" })
        }
      } else for (const path of removed) await rm(path, { recursive: true, force: true })
    } else for (const path of removed) await rm(path, { recursive: true, force: true })
    progress?.({ phase: "done" })
    return browserStatus(paths)
  })
}
async function activatePrepared(paths: RuntimePaths, prepared: string, version: string) {
  await privateDirectory(join(paths.home, "browsers"))
  const previous = await inspectBrowser(paths.browser)
  const backup = `${paths.browser}.switch-${randomUUID()}`
  let moved = false
  try {
    try {
      await rename(paths.browser, backup)
      moved = true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    }
    await rename(prepared, paths.browser)
    if (moved) {
      if (previous.installed && previous.version && previous.version !== version) {
        const slot = browserSlot(paths, previous.version)
        const cached = await inspectBrowser(slot)
        if (cached.installed && cached.version === previous.version) await rm(backup, { recursive: true, force: true })
        else await replaceDirectory(backup, slot)
      } else await rm(backup, { recursive: true, force: true })
    }
  } catch (cause) {
    if (moved && (await lstat(backup).catch(() => undefined))) {
      if (await lstat(paths.browser).catch(() => undefined)) await rename(paths.browser, prepared)
      await rename(backup, paths.browser)
    }
    throw cause
  }
}
export async function activateBrowser(paths = runtimePaths(), version?: string) {
  if (!version) throw new Error("Choose an installed browser version")
  const slot = browserSlot(paths, version)
  return installExclusive(paths.browser, async (check) => {
    await withStoppedServer(paths, async () => {
      check()
      await privateDirectory(join(paths.home, "browsers"))
      const active = await inspectBrowser(paths.browser)
      const stored = await inspectBrowser(slot)
      if (active.installed && active.version === version && !stored.installed) return
      if (!stored.installed || stored.version !== version)
        throw new Error("Install or repair this browser version first")
      await activatePrepared(paths, slot, version)
    })
    return browserStatus(paths)
  })
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex")
export async function backportBrowser(root: string, version = browserVersion) {
  const patches = [
    {
      archive: "omni.ja",
      name: "modules/psm/RemoteSecuritySettings.sys.mjs",
      hash: "85a5bda5150ac35af83476023e35ebc5025aba2e6a6659b479d5989b6ce73c6c",
      patchedHash: "5aa9bc1ae89ecc92a9e587792c320a2b0549d8969f09d9f4d1c9d9785d3d2e1d",
      transform: (data: Buffer) => {
        const marker = 'this.OneCRLBlocklistClient.on("sync", updateCertBlocklist);'
        const source = data.toString()
        if (source.split(marker).length !== 2) throw new Error("Browser revocation marker mismatch")
        return Buffer.from(
          source.replace(
            marker,
            marker +
              "\n    this.OneCRLBlocklistClient.get().then(records => updateCertBlocklist({ data: { current: records, created: records, updated: [], deleted: [] } })).catch(e => lazy.log.error(e));\n",
          ),
        )
      },
    },
    {
      archive: "browser/omni.ja",
      name: "defaults/settings/security-state/onecrl.json",
      hash: "d10b4a4a4d248a8849cb64621f2be17f29a2542eedd9d8ea5aa9028d2db9c986",
      patchedHash: "7404ae59f7c43bcc758e86bab1c342ca941e066c7a0fc5d0a783df8cc6e9d5b0",
      transform: (data: Buffer) => {
        const bundle = JSON.parse(data.toString())
        const ids = new Set(revocations.map(({ id }) => id))
        bundle.data = [...revocations, ...bundle.data.filter((record: { id: string }) => !ids.has(record.id))]
        bundle.timestamp = Math.max(bundle.timestamp, ...revocations.map(({ last_modified }) => last_modified))
        return Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`)
      },
    },
    {
      archive: "browser/omni.ja",
      name: "components/components.manifest",
      hash:
        browserBuild(version)?.securityManifestHash ??
        (browserBuild(version)?.launcher === "official"
          ? "dd781b7a8553d219dbc8ec6eeeaeefbcf15ce206625c008ff1af8bf66b9756d8"
          : process.platform === "darwin"
            ? "fb08eb95f25b6614a54a1e7ce9aa9b8bfdaf154ae9364b92ab265191b3358ff8"
            : process.platform === "win32"
              ? "a597aebd470cebbcd6b396b0066228a12ea662a673c8501bd62f6fc381da0103"
              : "bedf20f7f83a1528410fabb230ed785aa51e13ce10b140315d210db2d493d984"),
      transform: (data: Buffer) => {
        const before =
          "category browser-idle-startup resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs RemoteSecuritySettings.init"
        const source = data.toString()
        if (source.split(before).length !== 2) throw new Error("Browser startup manifest mismatch")
        return Buffer.from(source.replace(before, before.replace("browser-idle-startup", "browser-before-ui-startup")))
      },
      unpatch: (data: Buffer) =>
        Buffer.from(
          data
            .toString()
            .replace(
              "category browser-before-ui-startup resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs RemoteSecuritySettings.init",
              "category browser-idle-startup resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs RemoteSecuritySettings.init",
            ),
        ),
    },
  ]
  const archives = new Map<string, AdmZip>()
  for (const patch of patches) {
    const path = join(root, patch.archive)
    const info = await lstat(path)
    if (!info.isFile() || info.size > 128 * 1024 ** 2) throw new Error("Invalid browser security archive")
    const zip = archives.get(path) ?? new AdmZip(path)
    const entry = zip.getEntry(patch.name)
    if (!entry || entry.header.size > 8 * 1024 ** 2) throw new Error("Pinned browser security resource mismatch")
    const data = entry.getData()
    const hash = digest(data)
    if (hash !== patch.hash) {
      if (hash === patch.patchedHash || (patch.unpatch && digest(patch.unpatch(data)) === patch.hash)) continue
      throw new Error("Pinned browser security resource mismatch")
    }
    zip.updateFile(patch.name, patch.transform(data))
    archives.set(path, zip)
  }
  for (const [path, zip] of archives) zip.writeZip(path)
}
export async function finishBrowserInstall(
  paths: RuntimePaths,
  prepared: string,
  version: string,
  activate: boolean,
  signal?: AbortSignal,
) {
  const ready = await inspectBrowser(prepared)
  if (!ready.installed || ready.version !== version) throw new Error("Staged browser installation is incomplete")
  return installExclusive(
    paths.browser,
    async (check) => {
      const current = await inspectBrowser(paths.browser)
      check()
      await privateDirectory(join(paths.home, "browsers"))
      if (activate) {
        await withStoppedServer(paths, async () => {
          check()
          await activatePrepared(paths, prepared, version)
        })
      } else if (current.installed || (await control("status", paths))) {
        await replaceDirectory(prepared, browserSlot(paths, version))
      } else {
        await privateDirectory(paths.run)
        let release: (() => Promise<void>) | undefined
        try {
          release = await lockInstance(paths)
        } catch {
          await replaceDirectory(prepared, browserSlot(paths, version))
          return
        }
        try {
          check()
          await activatePrepared(paths, prepared, version)
        } finally {
          await release()
        }
      }
    },
    { wait: true, signal },
  )
}
export async function installBrowser(
  paths = runtimePaths(),
  signal?: AbortSignal,
  options: {
    force?: boolean
    progress?: ProgressReporter
    version?: string
    source?: string
    activate?: boolean
    resume?: boolean
  } = {},
) {
  if (options.source && !isAbsolute(options.source)) throw new Error("Choose an absolute browser directory")
  const source = options.source ? resolve(options.source) : undefined
  if (
    source &&
    [paths.browser, join(paths.home, "browsers")].some(
      (managed) =>
        source === resolve(managed) ||
        source.startsWith(resolve(managed) + sep) ||
        resolve(managed).startsWith(source + sep),
    )
  )
    throw new Error("Choose an installation outside the managed browser directory")
  const build = source
    ? await sourceVersion(source)
    : supportedBrowsers.find((build) => build.version === (options.version ?? browserVersion))
  if (!build) throw new Error("Unsupported browser build; choose a version from the supported catalog")
  return installExclusive(browserSlot(paths, build.version), async (check) => {
    const progress = options.progress
    const track =
      (phase: "download" | "extract" | "geoip" | "addons", unit: "bytes" | "files") =>
      (completed: number, total: number) =>
        progress?.({ phase, unit, completed, total })
    progress?.({ phase: "checking" })
    await privateDirectory(join(paths.home, "browsers"))
    const current = await browserStatus(paths)
    const stored = current.choices.find((choice) => choice.version === build.version)
    if (stored?.installed && !options.force && !source) {
      if (options.activate !== false && !stored.active) await activateBrowser(paths, build.version)
      progress?.({ phase: "done" })
      return browserStatus(paths)
    }
    if (current.installed && current.version === build.version && !options.force && !source) {
      progress?.({ phase: "done" })
      return current
    }
    if (options.activate !== false && (await control("status", paths)))
      throw new Error("Stop the managed server before installing its browser")
    const asset = build.assets[`${process.platform}-${process.arch}`]
    if (!asset) throw new Error("No compatible browser for this platform")
    await diskPreflight(paths.home, 4 * 1024 ** 3)
    const staged = `${paths.browser}.stage-${randomUUID()}`
    const downloads = join(paths.home, "downloads")
    await privateDirectory(downloads)
    const archive = join(downloads, `${asset.sha256}.zip`)
    try {
      if (source) {
        progress?.({ phase: "copy" })
        let copied = 0,
          bytes = 0
        await cp(source, staged, {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          filter: async (path) => {
            signal?.throwIfAborted()
            const info = await lstat(path)
            if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
              throw new Error("Browser source must not contain links or special files")
            copied++
            bytes += info.isFile() ? info.size : 0
            if (copied > 100000 || bytes > 4 * 1024 ** 3) throw new Error("Browser source exceeds the import budget")
            progress?.({ phase: "copy", unit: "files", completed: copied })
            return true
          },
        })
      } else {
        if ((await digestFile(archive).catch(() => "")) !== asset.sha256)
          await downloadVerified(asset, archive, signal, track("download", "bytes"), { resume: options.resume })
        await extractVerifiedZip(archive, staged, signal, track("extract", "files"))
      }
      if (source) {
        await rm(join(staged, "config.json"), { force: true })
        await rm(join(staged, ".0.5_FLAG"), { force: true })
      }
      const root = browserRoot(staged)
      progress?.({ phase: "patch" })
      await backportBrowser(root, build.version)
      // The upstream database only retains two releases; published native bundles must carry their pinned copy.
      const resources =
        process.env.TRAWL_RUNTIME_RESOURCES ||
        (process.env.TRAWL_RUNTIME_EXECUTABLE ? dirname(process.env.TRAWL_RUNTIME_EXECUTABLE) : paths.runtime)
      const bakedGeoip = join(resources, "GeoLite2-City.mmdb")
      if (build.launcher === "official") {
        const model = join(staged, "fpgen")
        await rm(model, { recursive: true, force: true })
        await cp(join(resources, "fpgen"), model, {
          recursive: true,
          filter: (path) => path !== join(resources, "fpgen/values.dat"),
        }).catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        })
        const modelArchive = join(staged, "fpgen-model.zip")
        try {
          await ensureModel({
            dir: model,
            fetchImpl: Object.assign(
              async (...[, init]: Parameters<typeof fetch>) => {
                const signals = [signal, init?.signal].filter((value): value is AbortSignal => Boolean(value))
                await downloadVerified(MODEL_PIN, modelArchive, signals.length ? AbortSignal.any(signals) : undefined)
                return new Response(await readFile(modelArchive))
              },
              { preconnect: fetch.preconnect },
            ),
          })
        } finally {
          await rm(modelArchive, { force: true })
        }
      }
      progress?.({ phase: "geoip" })
      if ((await digestFile(bakedGeoip).catch(() => "")) === geoipAsset.sha256)
        await copyFile(bakedGeoip, join(staged, "GeoLite2-City.mmdb"))
      else await downloadVerified(geoipAsset, join(staged, "GeoLite2-City.mmdb"), signal, track("geoip", "bytes"))
      const ubo = join(staged, "ubo.xpi")
      await downloadVerified(uboAsset, ubo, signal, track("addons", "bytes"))
      await rm(join(root, "addons", "UBO"), { recursive: true, force: true })
      await extractVerifiedZip(ubo, join(root, "addons", "UBO"), signal, track("addons", "files"))
      await rm(ubo, { force: true })
      const [version, release] = build.version.split("-")
      await writeFile(join(staged, "version.json"), JSON.stringify({ version, release }))
      await atomicJson(join(staged, "trawl-browser.json"), {
        version: build.version,
        platform: process.platform,
        arch: process.arch,
        securityBackport: true,
      })
      if (!(await inspectBrowser(staged)).installed) throw new Error("Staged browser installation is incomplete")
      progress?.({ phase: "activate" })
      signal?.throwIfAborted()
      check()
      await finishBrowserInstall(paths, staged, build.version, options.activate !== false, signal)
      await rm(archive, { force: true })
      progress?.({ phase: "done" })
      return browserStatus(paths)
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  })
}
