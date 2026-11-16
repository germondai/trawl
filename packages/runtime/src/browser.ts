import { createHash, randomUUID } from "node:crypto"
import { access, copyFile, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import AdmZip from "adm-zip"
import revocations from "../../browser/security/emudhra-onecrl.json"
import { digestFile, diskPreflight, downloadVerified, extractVerifiedZip, replaceDirectory } from "./assets"
import { browserAssets, browserVersion, geoipAsset, uboAsset } from "./browser-assets"
import { control, lockInstance } from "./control"
import { installExclusive } from "./install-lock"
import { type RuntimePaths, runtimePaths } from "./paths"
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
}
export async function browserStatus(paths = runtimePaths()): Promise<BrowserStatus> {
  const asset = browserAssets[`${process.platform}-${process.arch}`]
  const result: BrowserStatus = {
    installed: false,
    state: asset ? "not-installed" : "unsupported",
    supportedVersion: browserVersion,
    path: paths.browser,
    downloadBytes: asset?.size,
  }
  if (!asset) return result
  try {
    await lstat(paths.browser)
    result.state = "repair-needed"
    const state = JSON.parse(await readFile(join(paths.browser, "trawl-browser.json"), "utf8"))
    if (typeof state.version === "string" && state.version.length < 80) result.version = state.version
    if (!result.version) return result
    if (state.version !== browserVersion) {
      result.state = "update-available"
      return result
    }
    await access(browserExecutable(paths.browser))
    for (const name of [
      join(paths.browser, "GeoLite2-City.mmdb"),
      join(browserRoot(paths.browser), "addons/UBO/manifest.json"),
      join(paths.browser, "version.json"),
    ])
      if (!(await stat(name)).isFile() || (await stat(name)).size === 0) return result
    if (
      state.platform !== process.platform ||
      state.arch !== process.arch ||
      state.version !== browserVersion ||
      state.securityBackport !== true
    )
      return result
    return { ...result, installed: true, state: "ready" }
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
export async function uninstallBrowser(paths = runtimePaths()) {
  return installExclusive(paths.browser, async (check) => {
    const removed = `${paths.browser}.remove-${randomUUID()}`
    await withStoppedServer(paths, async () => {
      check()
      try {
        await rename(paths.browser, removed)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    })
    await rm(removed, { recursive: true, force: true })
    return browserStatus(paths)
  })
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex")
export async function backportBrowser(root: string) {
  const patches = [
    {
      archive: "omni.ja",
      name: "modules/psm/RemoteSecuritySettings.sys.mjs",
      hash: "85a5bda5150ac35af83476023e35ebc5025aba2e6a6659b479d5989b6ce73c6c",
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
        process.platform === "darwin"
          ? "fb08eb95f25b6614a54a1e7ce9aa9b8bfdaf154ae9364b92ab265191b3358ff8"
          : process.platform === "win32"
            ? "a597aebd470cebbcd6b396b0066228a12ea662a673c8501bd62f6fc381da0103"
            : "bedf20f7f83a1528410fabb230ed785aa51e13ce10b140315d210db2d493d984",
      transform: (data: Buffer) => {
        const before =
          "category browser-idle-startup resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs RemoteSecuritySettings.init"
        const source = data.toString()
        if (source.split(before).length !== 2) throw new Error("Browser startup manifest mismatch")
        return Buffer.from(source.replace(before, before.replace("browser-idle-startup", "browser-before-ui-startup")))
      },
    },
  ]
  const archives = new Map<string, AdmZip>()
  for (const patch of patches) {
    const path = join(root, patch.archive)
    const zip = archives.get(path) ?? new AdmZip(path)
    const entry = zip.getEntry(patch.name)
    if (!entry || digest(entry.getData()) !== patch.hash) throw new Error("Pinned browser security resource mismatch")
    zip.updateFile(patch.name, patch.transform(entry.getData()))
    archives.set(path, zip)
  }
  for (const [path, zip] of archives) zip.writeZip(path)
}
export async function installBrowser(paths = runtimePaths(), signal?: AbortSignal, options: { force?: boolean } = {}) {
  return installExclusive(paths.browser, async (check) => {
    const current = await browserStatus(paths)
    if (current.installed && !options.force) return current
    if (await control("status", paths)) throw new Error("Stop the managed server before installing its browser")
    const asset = browserAssets[`${process.platform}-${process.arch}`]
    if (!asset) throw new Error("No compatible browser for this platform")
    await diskPreflight(paths.home, 4 * 1024 ** 3)
    const staged = `${paths.browser}.stage-${randomUUID()}`
    const downloads = join(paths.home, "downloads")
    await privateDirectory(downloads)
    const archive = join(downloads, `${asset.sha256}.zip`)
    try {
      if ((await digestFile(archive).catch(() => "")) !== asset.sha256) await downloadVerified(asset, archive, signal)
      await extractVerifiedZip(archive, staged, signal)
      const root = browserRoot(staged)
      await backportBrowser(root)
      // The upstream database only retains two releases; published native bundles must carry their pinned copy.
      const resources =
        process.env.TRAWL_RUNTIME_RESOURCES ||
        (process.env.TRAWL_RUNTIME_EXECUTABLE ? dirname(process.env.TRAWL_RUNTIME_EXECUTABLE) : paths.runtime)
      const bakedGeoip = join(resources, "GeoLite2-City.mmdb")
      if ((await digestFile(bakedGeoip).catch(() => "")) === geoipAsset.sha256)
        await copyFile(bakedGeoip, join(staged, "GeoLite2-City.mmdb"))
      else await downloadVerified(geoipAsset, join(staged, "GeoLite2-City.mmdb"), signal)
      const ubo = join(staged, "ubo.xpi")
      await downloadVerified(uboAsset, ubo, signal)
      await extractVerifiedZip(ubo, join(root, "addons", "UBO"), signal)
      await rm(ubo, { force: true })
      const [version, release] = browserVersion.split("-")
      await writeFile(join(staged, "version.json"), JSON.stringify({ version, release }))
      await atomicJson(join(staged, "trawl-browser.json"), {
        version: browserVersion,
        platform: process.platform,
        arch: process.arch,
        securityBackport: true,
      })
      await withStoppedServer(paths, async () => {
        signal?.throwIfAborted()
        check()
        await replaceDirectory(staged, paths.browser)
      })
      await rm(archive, { force: true })
      return browserStatus(paths)
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  })
}
