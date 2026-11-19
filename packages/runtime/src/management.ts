import { redactEnvironment, settings } from "@trawl/config"
import { resourcePresets } from "@trawl/config/catalog"
import { installRuntime } from "./assets"
import { activateBrowser, browserStatus, installBrowser, uninstallBrowser } from "./browser"
import { discardBrowserDownload, pruneBrowserDownloads } from "./browser-cache"
import { control } from "./control"
import { resolveManagedEnvironment } from "./environment"
import { startManaged, stopManaged } from "./manager"
import { runtimePaths } from "./paths"
import type { ProgressReporter } from "./progress"
import { clearManagedStorage } from "./storage"
import { publicConfig, readConfig, tailLog, type UserConfig, validateConfig, writeConfig } from "./store"

export interface ManagementRequest {
  action: string
  home?: string
  config?: UserConfig
  source?: string
  profile?: "balanced" | "economy"
  browserVersion?: string
  browserId?: string
  resume?: boolean
  activate?: boolean
  storage?: string
}
export async function manage(
  request: ManagementRequest,
  signal?: AbortSignal,
  progress?: ProgressReporter,
): Promise<unknown> {
  signal?.throwIfAborted()
  if (!request || typeof request !== "object") throw new Error("Invalid management request")
  if (request.browserId !== undefined && typeof request.browserId !== "string")
    throw new Error("Invalid managed browser ID")
  if (request.resume !== undefined && typeof request.resume !== "boolean") throw Error("Invalid resume preference")
  if (request.activate !== undefined && typeof request.activate !== "boolean")
    throw new Error("Invalid activation preference")
  const paths = runtimePaths(request.home)
  switch (request.action) {
    case "bootstrap": {
      await pruneBrowserDownloads(paths)
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
      config.env = { ...config.env, ...resourcePresets[request.profile] }
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
    case "clearStorage":
      return clearManagedStorage(request.storage ?? "", paths)
    case "discardBrowserDownload":
      return discardBrowserDownload(paths, request.browserVersion)
    case "browserStatus":
      return browserStatus(paths)
    case "importBrowser":
      if (
        typeof request.source !== "string" ||
        !request.source ||
        request.source.length > 8192 ||
        /[\r\n\0]/.test(request.source)
      )
        throw new Error("Invalid browser source directory")
      return installBrowser(paths, signal, { source: request.source, progress })
    case "activateBrowser":
      return activateBrowser(paths, request.browserVersion)
    case "installBrowser":
      return installBrowser(paths, signal, {
        progress,
        version: request.browserVersion,
        activate: request.activate,
        resume: request.resume,
      })
    case "repairBrowser":
      return installBrowser(paths, signal, {
        force: true,
        resume: request.resume,
        progress,
        version: request.browserVersion,
        activate: request.activate,
      })
    case "uninstallBrowser":
      return uninstallBrowser(paths, progress, request.browserVersion, request.browserId)
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
