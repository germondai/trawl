import { randomUUID } from "node:crypto"
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { digestFile, diskPreflight, downloadVerified, replaceDirectory, verifyRuntime } from "../src/assets"
import { geoipAsset } from "../src/browser-assets"
import mediaAssets from "../src/media-assets.json"
import { collectLicenses } from "./licenses"

const root = resolve(import.meta.dir, "../../..")
const destination = resolve(process.env.TRAWL_RUNTIME_OUTPUT || join(root, ".artifacts/v2/runtime"))
const output = `${destination}.stage-${randomUUID()}`
try {
  const minimumFreeGiB = Number(process.env.TRAWL_BUILD_MIN_FREE_GIB || 20)
  if (!Number.isFinite(minimumFreeGiB) || minimumFreeGiB < 4)
    throw new Error("Build disk reserve must be at least 4 GiB")
  await diskPreflight(root, minimumFreeGiB * 1024 ** 3)
  await mkdir(output, { recursive: true })
  const executable = join(output, process.platform === "win32" ? "trawl-server.exe" : "trawl-server")
  for (const [source, name] of [
    ["apps/api/src/index.ts", "api.mjs"],
    ["packages/tiers/src/utils/nativePowSolver.ts", "pow-worker.mjs"],
  ]) {
    const build = await Bun.build({
      entrypoints: [join(root, source)],
      outdir: output,
      naming: name,
      target: "bun",
      format: "esm",
      minify: true,
      external: ["camoufox-js", "playwright-core", "node-wreq"],
    })
    if (!build.success) throw new AggregateError(build.logs, `Cannot bundle ${name}`)
  }
  const main = await Bun.build({
    entrypoints: [join(root, "packages/runtime/src/server.ts")],
    outdir: output,
    naming: "runtime.mjs",
    target: "bun",
    format: "esm",
    minify: true,
  })
  if (!main.success) throw new AggregateError(main.logs, "Runtime bundle failed")
  await cp(process.execPath, join(output, process.platform === "win32" ? "trawl-engine.exe" : "trawl-engine"))
  const installed = new Map<string, string>()
  async function stage(name: string, from: string, parent = output, optional = false) {
    const require = createRequire(join(from, "package.json"))
    let source: string
    try {
      source = dirname(require.resolve(`${name}/package.json`))
    } catch {
      let entry: string
      try {
        entry = require.resolve(name)
      } catch {
        if (optional) return
        throw new Error(`Missing required runtime dependency: ${name}`)
      }
      source = dirname(entry)
      while (source !== dirname(source)) {
        try {
          const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
          if (manifest.name === name) break
        } catch {}
        source = dirname(source)
      }
    }
    const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
    const key = `${pkg.name}@${pkg.version}`
    if (installed.get(name) === key) return
    const dest = join(installed.has(name) ? parent : output, "node_modules", name)
    installed.set(name, key)
    await cp(source, dest, {
      recursive: true,
      dereference: true,
      filter: (path) =>
        path === source ||
        !path
          .slice(source.length + 1)
          .split(/[\\/]/)
          .includes("node_modules"),
    })
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }))
      await stage(
        dependency,
        source,
        dest,
        Boolean(pkg.optionalDependencies?.[dependency] || pkg.peerDependenciesMeta?.[dependency]?.optional),
      )
  }
  await stage("camoufox-js", join(root, "packages/browser"))
  await stage("playwright-core", join(root, "packages/browser"))
  await stage("node-wreq", join(root, "packages/tiers"))
  async function run(command: string[], cwd = root) {
    const child = Bun.spawn(command, {
      cwd,
      env: { ...process.env, CARGO_BUILD_JOBS: "2", GOMAXPROCS: "2" },
      stdout: "inherit",
      stderr: "inherit",
    })
    if ((await child.exited) !== 0) throw new Error(`${command[0]} build failed`)
  }
  await run(["cargo", "build", "--release", "--locked", "--manifest-path", "native/launcher/Cargo.toml"])
  await cp(
    join(root, "native/launcher/target/release", process.platform === "win32" ? "trawl-server.exe" : "trawl-server"),
    executable,
  )
  await run(["cargo", "build", "--release", "--locked", "--manifest-path", "native/powsolve/Cargo.toml"])
  const library = `libpowsolve${process.platform === "darwin" ? ".dylib" : process.platform === "win32" ? ".dll" : ".so"}`
  await cp(
    join(root, "native/powsolve/target/release", process.platform === "win32" ? "powsolve.dll" : library),
    join(output, library),
  )
  await run(["sh", "build.sh"], join(root, "tools/wafmeow"))
  await cp(
    join(root, "tools/wafmeow/dist", process.platform === "win32" ? "trawl-waf.exe" : "trawl-waf"),
    join(output, process.platform === "win32" ? "trawl-waf.exe" : "trawl-waf"),
  )
  await cp(join(root, "tools/wafmeow/dist/waf-fingerprints.json"), join(output, "waf-fingerprints.json"))
  await mkdir(join(output, "licenses"), { recursive: true })

  const media = mediaAssets[`${process.platform}-${process.arch}` as keyof typeof mediaAssets]
  if (!media) throw new Error("No compatible audio helper for this platform")
  const cache = join(root, ".artifacts/v2/downloads")
  await mkdir(cache, { recursive: true })
  const geoipCache = join(cache, geoipAsset.sha256)
  if ((await digestFile(geoipCache).catch(() => "")) !== geoipAsset.sha256)
    await downloadVerified(geoipAsset, geoipCache)
  await cp(geoipCache, join(output, "GeoLite2-City.mmdb"))
  await writeFile(
    join(output, "licenses/GeoIP.txt"),
    "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com. Pinned source: " +
      geoipAsset.url +
      "\n",
  )
  for (const [kind, asset] of Object.entries(media)) {
    const cached = join(cache, asset.sha256)
    if ((await digestFile(cached).catch(() => "")) !== asset.sha256) await downloadVerified(asset, cached)
    const name =
      kind === "binary" ? (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") : `licenses/FFmpeg-${kind}.txt`
    await cp(cached, join(output, name))
    if (kind === "binary") await chmod(join(output, name), 0o755)
  }
  await cp(join(root, "packages/runtime/licenses/Bun.txt"), join(output, "licenses/Bun.txt"))

  for (const [source, name] of [
    ["LICENSE", "TRAWL"],
    ["native/powsolve/ANUBIS-LICENSE", "Anubis"],
    ["tools/wafmeow/dist/LICENSE", "wafmeow"],
  ])
    await cp(join(root, source), join(output, "licenses", name))
  await collectLicenses(root, join(output, "licenses"))
  const files: Record<string, string> = {}
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.isFile() && path !== join(output, "manifest.json")) {
        const metadata = await (await import("node:fs/promises")).stat(path)
        await chmod(path, metadata.mode & 0o111 ? 0o755 : 0o644)
        files[
          path
            .slice(output.length + 1)
            .split("\\")
            .join("/")
        ] = await digestFile(path)
      } else if (!entry.isFile()) throw new Error("Unexpected runtime resource type")
    }
  }
  await scan(output)
  await writeFile(
    join(output, "manifest.json"),
    `${JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, bunVersion: Bun.version, files }, null, 2)}\n`,
  )
  await verifyRuntime(output)
  await replaceDirectory(output, destination)
  console.log(`Runtime bundle ready: ${destination}`)
} finally {
  await rm(output, { recursive: true, force: true })
}
