import { profiles, redactEnvironment, settings } from "@trawl/config"
import { installRuntime } from "./assets"
import { browserStatus, installBrowser, uninstallBrowser } from "./browser"
import { control } from "./control"
import { resolveManagedEnvironment } from "./environment"
import { startManaged, stopManaged } from "./manager"
import { runtimePaths } from "./paths"
import { publicConfig, readConfig, tailLog, type UserConfig, validateConfig, writeConfig } from "./store"

export interface ManagementRequest {
  action: string
  home?: string
  config?: UserConfig
  source?: string
  profile?: "balanced" | "economy"
}
export async function manage(request: ManagementRequest, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  if (!request || typeof request !== "object") throw new Error("Invalid management request")
  const paths = runtimePaths(request.home)
  switch (request.action) {
    case "bootstrap": {
      const config = await readConfig(paths)
      const resolved = resolveManagedEnvironment(paths, config.env)
      return {
        config: publicConfig(config),
        effective: redactEnvironment(resolved.values),
        sources: resolved.sources,
        inherited: redactEnvironment(resolveManagedEnvironment(paths).values),
        catalog: settings,
        status: (await control("status", paths)) ?? { running: false },
        browser: await browserStatus(paths),
      }
    }
    case "catalog":
      return settings
    case "config": {
      const config = await readConfig(paths)
      return {
        config: publicConfig(config),
        effective: redactEnvironment(resolveManagedEnvironment(paths, config.env).values),
        sources: resolveManagedEnvironment(paths, config.env).sources,
        inherited: redactEnvironment(resolveManagedEnvironment(paths).values),
      }
    }
    case "saveConfig": {
      if (!request.config) throw new Error("Missing configuration")
      const before = await readConfig(paths)
      const input = request.config
      input.env = Object.fromEntries(
        Object.entries(input.env).map(([key, value]) => [
          key,
          value === "[redacted]" ? (before.env[key] ?? "") : value,
        ]),
      )
      input.desktop.connections = input.desktop.connections.map((connection) => ({
        ...connection,
        apiKey:
          connection.apiKey === "[redacted]"
            ? before.desktop.connections.find(({ id }) => id === connection.id)?.apiKey
            : connection.apiKey,
      }))
      const checked = validateConfig(input)
      await writeConfig(checked, paths)
      return publicConfig(checked)
    }
    case "profile": {
      if (request.profile !== "balanced" && request.profile !== "economy") throw new Error("Unknown profile")
      const config = await readConfig(paths)
      config.env = { ...config.env, ...profiles[request.profile] }
      if (request.profile === "balanced") {
        config.env.BROWSER_COLD_BOOT = "false"
        config.env.BROWSER_IDLE_TIMEOUT_MS = "0"
        config.env.WAF_DETECTION_ENABLED = "true"
      }
      await writeConfig(config, paths)
      return publicConfig(config)
    }
    case "status":
      return (await control("status", paths)) ?? { running: false }
    case "start":
      return startManaged(paths)
    case "stop":
      return stopManaged(paths, undefined, signal)
    case "stopOwned":
      return stopManaged(paths, "desktop", signal)
    case "logs":
      return tailLog(paths)
    case "browserStatus":
      return browserStatus(paths)
    case "installBrowser":
      return installBrowser(paths, signal)
    case "repairBrowser":
      return installBrowser(paths, signal, { force: true })
    case "uninstallBrowser":
      return uninstallBrowser(paths)
    case "installRuntime":
      if (!request.source) throw new Error("Missing verified runtime source")
      await installRuntime(request.source, paths)
      return { installed: true }
    case "doctor":
      return {
        platform: process.platform,
        arch: process.arch,
        home: paths.home,
        browser: await browserStatus(paths),
        instance: (await control("status", paths)) ?? { running: false },
        configValid: Boolean(await readConfig(paths)),
      }
    default:
      throw new Error("Unknown management operation")
  }
}
