import { randomBytes } from "node:crypto"
import { access } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { flagEnvironment, settingFlags, validateEnvironment } from "@trawl/config"
import { browserStatus } from "./browser"
import { control, startControl } from "./control"
import { resolveManagedEnvironment } from "./environment"
import { maintainLogs } from "./logs"
import { runtimePaths } from "./paths"
import { privateDirectory, readConfig, writeConfig } from "./store"

export async function runServer(args: string[]) {
  if (args[0] === "serve") args = args.slice(1)
  const { values } = parseArgs({
    args,
    options: {
      ...settingFlags(),
      home: { type: "string" },
      owner: { type: "string" },
      "watch-parent": { type: "boolean" },
      "env-json": { type: "string" },
      service: { type: "boolean" },
    },
    strict: true,
  })
  const paths = runtimePaths(values.home)
  if (await control("status", paths)) throw new Error("A managed instance is already running")
  const owner = values.owner ?? "foreground"
  if (!["cli", "desktop", "foreground"].includes(owner)) throw new Error("Invalid instance owner")
  await privateDirectory(paths.home)
  const file = await readConfig(paths)
  const resolved = resolveManagedEnvironment(paths, file.env, process.env, {
    ...(values["env-json"] ? validateEnvironment(JSON.parse(values["env-json"])) : {}),
    ...flagEnvironment(values),
  })
  const env = resolved.values
  let configChanged = false
  if (!env.METRICS_DASHBOARD_TOKEN && owner === "desktop") {
    file.env.METRICS_DASHBOARD_TOKEN = randomBytes(32).toString("hex")
    file.env.METRICS_DASHBOARD_ENABLED = "true"
    configChanged = true
    env.METRICS_DASHBOARD_TOKEN = file.env.METRICS_DASHBOARD_TOKEN
  }
  if (owner === "desktop" && resolved.sources.OBSERVABILITY_ENABLED === "default") {
    file.env.OBSERVABILITY_ENABLED = "true"
    env.OBSERVABILITY_ENABLED = "true"
    configChanged = true
  }
  if (configChanged) await writeConfig(file, paths)
  if (owner === "desktop") env.METRICS_DASHBOARD_ENABLED = "true"
  const browser = await browserStatus(paths)
  if (!browser.installed)
    throw new Error(
      "Browser is not installed. Run trawl-server setup (or trawl browser install) before starting the server.",
    )
  const resources = process.env.TRAWL_RUNTIME_RESOURCES || dirname(process.execPath)
  const extension = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so"
  const library = join(resources, `libpowsolve${extension}`)
  const waf = join(resources, process.platform === "win32" ? "trawl-waf.exe" : "trawl-waf")
  Object.assign(process.env, env, {
    CAMOUFOX_INSTALL_DIR: browser.path,
    POWSOLVE_LIB: library,
    WAFMEOW_PATH: waf,
    TRAWL_MANAGED_INSTANCE: "1",
  })
  process.env.TRAWL_POW_WORKER_PATH = join(resources, "pow-worker.mjs")
  const ffmpeg = join(resources, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
  if (
    !env.FFMPEG_PATH &&
    (await access(ffmpeg).then(
      () => true,
      () => false,
    ))
  )
    process.env.FFMPEG_PATH = ffmpeg
  const host = env.HOST === "0.0.0.0" || env.HOST === "::" ? "127.0.0.1" : env.HOST
  const baseURL = `http://${host.includes(":") ? `[${host}]` : host}:${env.PORT}`
  let close: () => Promise<void> = async () => {}
  let ready = false
  const shutdown = () => {
    if (process.listenerCount("SIGTERM") === 0) process.exit(0)
    process.emit("SIGTERM", "SIGTERM")
  }
  const watchingParent = values["watch-parent"] || process.env.TRAWL_PARENT_WATCH === "1"
  if (watchingParent) {
    process.stdin.once("end", shutdown)
    process.stdin.resume()
  }
  try {
    close = await startControl(
      paths,
      {
        baseURL,
        owner: owner as "cli" | "desktop" | "foreground",
        dashboardToken: env.METRICS_DASHBOARD_TOKEN,
        shutdownDrainMs: Number(env.BROWSER_SHUTDOWN_DRAIN_MS),
        listenHost: host,
      },
      shutdown,
      () => ready,
    )
    if (!(await browserStatus(paths)).installed)
      throw new Error("Browser installation changed during startup; install it before starting the server")
    maintainLogs(paths)
    await import(pathToFileURL(join(resources, "api.mjs")).href)
    ready = true
  } catch (error) {
    if (watchingParent) {
      // A live parent pipe must not keep a failed child running.
      process.stdin.removeListener("end", shutdown)
      process.stdin.destroy()
    }
    await close()
    throw error
  }
}
