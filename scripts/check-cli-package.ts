import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { requiredRuntimeFiles } from "../packages/runtime/src/assets"

const root = resolve(import.meta.dir, "..")
const directory = await mkdtemp(join(tmpdir(), "trawl-cli-pack-"))
async function run(command: string[], cwd = directory) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${error || out}`)
  return out.trim()
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ msg: "TRAWL fixture", version: "fixture", uptime: 1 }),
})
try {
  const archives: string[] = []
  for (const name of ["client", "cli"]) {
    const packed = JSON.parse(
      await run([
        "npm",
        "pack",
        join(root, "packages", name),
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        directory,
      ]),
    )
    archives.push(join(directory, packed[0].filename))
  }
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...archives])
  const path = join(directory, "node_modules/@trawl/cli/dist/index.mjs")
  const manifest = JSON.parse(await readFile(join(directory, "node_modules/@trawl/cli/package.json"), "utf8"))
  if (Object.values(manifest.dependencies).some((value) => String(value).startsWith("workspace:")))
    throw new Error("Private workspace dependency in public CLI package")
  const source = join(directory, "fixture-runtime")
  const files: Record<string, string> = {}
  for (const name of requiredRuntimeFiles()) {
    const path = join(source, name)
    await mkdir((await import("node:path")).dirname(path), { recursive: true })
    await writeFile(path, "owned fixture")
    files[name] = createHash("sha256").update("owned fixture").digest("hex")
  }
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, files }),
  )
  for (const runtime of ["node", "bun", "deno"]) {
    if (!Bun.which(runtime)) throw new Error(`${runtime} must be installed`)
    const prefix =
      runtime === "deno" ? ["run", "--no-config", "--node-modules-dir=manual", "--no-lock", "--allow-all"] : []
    const version = await run([runtime, ...prefix, path, "--version"])
    if (version.trim() !== manifest.version) throw new Error("CLI version does not match its package manifest")
    const help = await run([runtime, ...prefix, path, "--help"])
    if (!help.includes("Usage: trawl")) throw new Error("CLI help missing")
    const info = JSON.parse(
      await run([
        runtime,
        ...prefix,
        path,
        "info",
        "--base-url",
        `http://127.0.0.1:${server.port}`,
        "--home",
        join(directory, "home"),
      ]),
    )
    if (info.version !== "fixture") throw new Error("CLI transport failed")
    const home = join(directory, `${runtime}-home`)
    const profile = JSON.parse(await run([runtime, ...prefix, path, "config", "profile", "economy", "--home", home]))
    if (profile.env.BROWSER_COLD_BOOT !== "true") throw new Error("CLI config storage failed")
    const installed = JSON.parse(
      await run([runtime, ...prefix, path, "runtime", "install", "--from", source, "--home", home]),
    )
    if (installed.installed !== true) throw new Error("CLI runtime installation failed")
    console.log(`${runtime}: packed CLI, API, config and verified fixture installation passed`)
  }
} finally {
  await server.stop(true)
  await rm(directory, { recursive: true, force: true })
}
