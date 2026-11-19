import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, statfs } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { type Entry, open as openZip, type ZipFile } from "yauzl"
import { control, lockInstance } from "./control"
import { installExclusive } from "./install-lock"
import { type RuntimePaths, runtimePaths } from "./paths"
import { atomicJson, privateDirectory } from "./store"

export interface Download {
  url: string
  sha256: string
  size: number
}
export async function diskPreflight(directory: string, requiredBytes = 1024 ** 3) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const disk = await statfs(directory)
  const available = disk.bavail * disk.bsize
  if (available < requiredBytes)
    throw new Error(`Insufficient disk space: ${Math.floor(available / 1024 ** 3)} GiB available`)
  return available
}
export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
export async function downloadVerified(
  asset: Download,
  destination: string,
  signal?: AbortSignal,
  progress?: (completed: number, total: number) => void,
  options: { resume?: boolean } = {},
) {
  if (
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > 2 * 1024 ** 3 ||
    new URL(asset.url).protocol !== "https:"
  )
    throw new Error("Invalid download manifest")
  if (options.resume) return resumeVerifiedDownload(asset, destination, signal, progress)
  progress?.(0, asset.size)
  const response = await fetch(asset.url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000),
  })
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`)
  const temporary = `${destination}.${randomUUID()}.partial`
  let bytes = 0
  const hash = createHash("sha256")
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(temporary, "wx", 0o600)
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk, _, callback) {
          bytes += chunk.length
          if (bytes > asset.size) callback(new Error("Download exceeds its declared size"))
          else {
            hash.update(chunk)
            progress?.(bytes, asset.size)
            callback(null, chunk)
          }
        },
      }),
      file.createWriteStream(),
      { signal },
    )
    if (bytes !== asset.size || hash.digest("hex") !== asset.sha256)
      throw new Error("Downloaded asset failed size or SHA-256 verification")
    await rename(temporary, destination)
  } finally {
    await file?.close()
    if (!response.body.locked) await response.body.cancel().catch(() => {})
    await rm(temporary, { force: true })
  }
}
async function resumeVerifiedDownload(
  asset: Download,
  destination: string,
  signal?: AbortSignal,
  progress?: (completed: number, total: number) => void,
) {
  const temporary = `${destination}.partial`,
    metadata = `${temporary}.json`
  let offset = 0,
    previous: { etag?: string; modified?: string } = {}
  const discard = async () => {
    await rm(temporary, { force: true })
    await rm(metadata, { force: true })
  }
  try {
    const info = await lstat(temporary),
      stamp = await lstat(metadata)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > asset.size ||
      !stamp.isFile() ||
      stamp.isSymbolicLink() ||
      stamp.size > 8192 ||
      Date.now() - info.mtimeMs > 86400000
    )
      throw Error("Invalid partial download")
    const value = JSON.parse(await readFile(metadata, "utf8"))
    if (
      value.url !== asset.url ||
      value.sha256 !== asset.sha256 ||
      value.size !== asset.size ||
      [value.etag, value.modified].some(
        (item) => item !== undefined && (typeof item !== "string" || item.length > 1024 || /[\r\n\0]/.test(item)),
      )
    )
      throw Error("Partial download does not match the pinned asset")
    offset = info.size
    previous = value
  } catch {
    await discard()
  }
  if (offset === asset.size) {
    if ((await digestFile(temporary)) === asset.sha256) {
      await rename(temporary, destination)
      await rm(metadata, { force: true })
      progress?.(asset.size, asset.size)
      return
    }
    await discard()
    offset = 0
  }
  progress?.(offset, asset.size)
  const fetchAsset = (start: number) =>
    fetch(asset.url, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000),
      headers: {
        "Accept-Encoding": "identity",
        ...(start
          ? {
              Range: `bytes=${start}-`,
              ...(previous.etag || previous.modified ? { "If-Range": previous.etag || previous.modified! } : {}),
            }
          : {}),
      },
    })
  let response = await fetchAsset(offset)
  const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  const validatorChanged =
    previous.etag && response.headers.get("etag") && previous.etag !== response.headers.get("etag")
  if (
    offset &&
    (response.status === 416 ||
      (response.status === 206 &&
        (!range ||
          Number(range[1]) !== offset ||
          Number(range[3]) !== asset.size ||
          Number(range[2]) < offset ||
          Number(range[2]) >= asset.size ||
          validatorChanged)))
  ) {
    await response.body?.cancel()
    await discard()
    offset = 0
    progress?.(0, asset.size)
    response = await fetchAsset(0)
  }
  if (!response.ok || !response.body || (response.status !== 200 && response.status !== 206)) {
    await response.body?.cancel()
    throw Error(`Download failed (HTTP ${response.status})`)
  }
  if (response.status === 200 && offset) {
    offset = 0
    progress?.(0, asset.size)
  }
  if (!offset && response.status === 206) {
    const first = response.headers.get("content-range")?.match(/^bytes 0-(\d+)\/(\d+)$/)
    if (!first || Number(first[2]) !== asset.size || Number(first[1]) >= asset.size) {
      await response.body.cancel()
      await discard()
      throw Error("Invalid download range")
    }
  }
  const hash = createHash("sha256")
  if (offset) for await (const chunk of createReadStream(temporary)) hash.update(chunk)
  let bytes = offset,
    invalid = false
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        (offset ? constants.O_APPEND : constants.O_TRUNC) |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    await atomicJson(metadata, {
      url: asset.url,
      sha256: asset.sha256,
      size: asset.size,
      etag: response.headers.get("etag") ?? undefined,
      modified: response.headers.get("last-modified") ?? undefined,
    })
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk, _, callback) {
          bytes += chunk.length
          if (bytes > asset.size) {
            invalid = true
            callback(Error("Download exceeds its declared size"))
            return
          }
          hash.update(chunk)
          progress?.(bytes, asset.size)
          callback(null, chunk)
        },
      }),
      file.createWriteStream(),
      { signal },
    )
    if (bytes !== asset.size) throw Error("Download interrupted; retry to resume")
    if (hash.digest("hex") !== asset.sha256) {
      invalid = true
      throw Error("Downloaded asset failed SHA-256 verification")
    }
    await rename(temporary, destination)
    await rm(metadata, { force: true })
  } finally {
    await file?.close()
    if (!response.body.locked) await response.body.cancel().catch(() => {})
    if (invalid) await discard()
  }
}
export async function extractVerifiedZip(
  archive: string,
  destination: string,
  signal?: AbortSignal,
  progress?: (completed: number, total: number) => void,
) {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    openZip(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) =>
      error || !zip ? reject(new Error("Unsafe or invalid archive")) : resolve(zip),
    )
  })
  try {
    if (zip.entryCount > 30000) throw new Error("Archive contains too many entries")
    let entries = 0
    progress?.(0, zip.entryCount)
    await privateDirectory(destination)
    let total = 0
    await new Promise<void>((resolve, reject) => {
      let failed = false
      const fail = (error: unknown) => {
        if (!failed) {
          failed = true
          reject(error)
        }
      }
      zip.on("error", () => fail(new Error("Unsafe or invalid archive")))
      zip.on("end", resolve)
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          signal?.throwIfAborted()
          const name = entry.fileName
          if (
            !name ||
            isAbsolute(name) ||
            /[\\:\0]/.test(name) ||
            name.split("/").some((part) => part === "." || part === "..")
          )
            throw new Error("Unsafe archive path")
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
            throw new Error("Symlinks are not accepted in runtime archives")
          total += entry.uncompressedSize
          if (entry.uncompressedSize > 2 * 1024 ** 3 || total > 4 * 1024 ** 3)
            throw new Error("Archive exceeds extraction limits")
          const target = resolvePath(destination, name)
          if (name.endsWith("/")) {
            await mkdir(target, { recursive: true, mode: 0o755 })
            return
          }
          await mkdir(dirname(target), { recursive: true, mode: 0o755 })
          const input = await new Promise<import("node:stream").Readable>((resolve, reject) =>
            zip.openReadStream(entry, (error, stream) =>
              error || !stream ? reject(new Error("Invalid archive entry")) : resolve(stream),
            ),
          )
          let actual = 0
          await pipeline(
            input,
            new Transform({
              transform(chunk, _, callback) {
                actual += chunk.length
                callback(
                  actual > entry.uncompressedSize ? new Error("Archive entry exceeds its declared size") : null,
                  chunk,
                )
              },
            }),
            createWriteStream(target, {
              flags: "wx",
              mode: (entry.externalFileAttributes >>> 16) & 0o111 ? 0o755 : 0o644,
            }),
            { signal },
          )
        })().then(() => {
          progress?.(++entries, zip.entryCount)
          if (!failed) zip.readEntry()
        }, fail)
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}
function resolvePath(directory: string, name: string) {
  const target = resolve(directory, name)
  if (!target.startsWith(resolve(directory) + sep)) throw new Error("Unsafe archive destination")
  return target
}
export async function replaceDirectory(staged: string, destination: string) {
  const previous = `${destination}.previous-${randomUUID()}`
  let moved = false
  try {
    try {
      await rename(destination, previous)
      moved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await rename(staged, destination)
  } catch (error) {
    if (moved) await rename(previous, destination)
    throw error
  }
  if (moved) await rm(previous, { recursive: true, force: true })
}
export interface RuntimeManifest {
  version: 1
  platform: string
  arch: string
  files: Record<string, string>
}
export function requiredRuntimeFiles() {
  const suffix = process.platform === "win32" ? ".exe" : ""
  const library =
    process.platform === "win32"
      ? "libpowsolve.dll"
      : process.platform === "darwin"
        ? "libpowsolve.dylib"
        : "libpowsolve.so"
  return [
    `trawl-server${suffix}`,
    `trawl-engine${suffix}`,
    "runtime.mjs",
    "api.mjs",
    "pow-worker.mjs",
    `trawl-waf${suffix}`,
    `ffmpeg${suffix}`,
    library,
    "waf-fingerprints.json",
    "GeoLite2-City.mmdb",
    "licenses/TRAWL",
    "licenses/Bun.txt",
    "node_modules/camoufox-js/package.json",
    "node_modules/playwright-core/package.json",
    "node_modules/node-wreq/package.json",
  ]
}
export async function verifyRuntime(directory: string): Promise<RuntimeManifest> {
  const file = join(directory, "manifest.json")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 ** 2) throw new Error("Invalid runtime manifest")
  const manifest = JSON.parse(await readFile(file, "utf8")) as RuntimeManifest
  if (
    manifest.version !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error("Runtime platform or manifest mismatch")
  const names = Object.keys(manifest.files)
  if (!requiredRuntimeFiles().every((name) => names.includes(name)) || names.length > 30000)
    throw new Error("Incomplete runtime manifest")
  const actual = new Set<string>()
  async function scan(root: string, prefix = "") {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const name = prefix + entry.name
      const path = join(root, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error("Runtime cannot contain symlinks")
      if (metadata.isDirectory()) await scan(path, `${name}/`)
      else if (metadata.isFile()) {
        if (name !== "manifest.json") actual.add(name)
        if (actual.size > 30000) throw new Error("Runtime contains too many files")
      } else throw new Error("Unexpected runtime resource type")
    }
  }
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Runtime must be a real directory")
  await scan(directory)
  if (actual.size !== names.length) throw new Error("Runtime contains unlisted or missing resources")
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (
      isAbsolute(name) ||
      name.includes("\\") ||
      name.includes(":") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !actual.has(name)
    )
      throw new Error("Invalid runtime manifest entry")
    if ((await digestFile(join(directory, name))) !== digest) throw new Error("Runtime resource failed verification")
  }
  return manifest
}
export async function installRuntime(source: string, paths: RuntimePaths = runtimePaths()) {
  const destination = paths.runtime
  return installExclusive(destination, async (check) => {
    if (await control("status", paths)) throw new Error("Stop the managed server before replacing its runtime")
    await privateDirectory(paths.run)
    const release = await lockInstance(paths)
    try {
      const from = resolve(source),
        to = resolve(destination)
      if (from === to || from.startsWith(to + sep) || to.startsWith(from + sep))
        throw new Error("Runtime source and destination must be separate directories")
      await diskPreflight(dirname(destination))
      await verifyRuntime(source)
      const { cp } = await import("node:fs/promises")
      const staged = `${destination}.stage-${randomUUID()}`
      try {
        await cp(source, staged, { recursive: true, dereference: false })
        await verifyRuntime(staged)
        check()
        await replaceDirectory(staged, destination)
      } finally {
        await rm(staged, { recursive: true, force: true })
      }
      await chmod(join(destination, process.platform === "win32" ? "trawl-server.exe" : "trawl-server"), 0o755)
    } finally {
      await release()
    }
  })
}
