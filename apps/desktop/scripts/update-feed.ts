import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

const targets: Record<string, string[]> = {
  "darwin-aarch64": [".app.tar.gz"],
  "darwin-x86_64": [".app.tar.gz"],
  "linux-aarch64": [".AppImage", ".deb"],
  "linux-x86_64": [".AppImage", ".deb"],
  "windows-aarch64": [".exe", ".msi"],
  "windows-x86_64": [".exe", ".msi"],
  "android-aarch64": [".apk"],
  "android-armv7": [".apk"],
}

export async function buildUpdateFeed(version: string, folder: string, notes = "") {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Use a stable x.y.z release version")
  const entries = await readdir(folder, { withFileTypes: true })
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
  const platforms: Record<string, { url: string; signature: string }> = {}
  for (const [target, extensions] of Object.entries(targets)) {
    for (const extension of extensions) {
      const name = `TRAWL_${version}_${target}${extension}`
      if (!files.has(name)) continue
      const platform = target.startsWith("linux-") ? `${target}-${extension === ".deb" ? "deb" : "appimage"}` : target
      if (platforms[platform]) throw new Error(`Choose one installer for ${target}`)
      if (!files.has(`${name}.sig`) || !(await stat(join(folder, name))).size)
        throw new Error(`Missing package or signature: ${name}`)
      const signature = (await readFile(join(folder, `${name}.sig`), "utf8")).trim()
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 8192)
        throw new Error(`Invalid signature encoding: ${name}`)
      platforms[platform] = {
        url: `https://github.com/germondai/trawl/releases/download/v${version}/${encodeURIComponent(basename(name))}`,
        signature,
      }
    }
  }
  if (!Object.keys(platforms).length) throw new Error("No signed update packages found")
  return { version, notes: notes.slice(0, 12000), pub_date: new Date().toISOString(), platforms }
}

if (import.meta.main) {
  const [version, folder, output, notesFile] = process.argv.slice(2)
  if (!version || !folder || !output)
    throw new Error("Usage: bun scripts/update-feed.ts VERSION ASSET_FOLDER OUTPUT_JSON [NOTES_FILE]")
  const feed = await buildUpdateFeed(version, folder, notesFile ? await readFile(notesFile, "utf8") : "")
  await writeFile(output, `${JSON.stringify(feed, null, 2)}\n`)
  console.log(`Prepared update feed for ${Object.keys(feed.platforms).join(", ")}`)
}
