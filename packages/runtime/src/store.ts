import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { emptyConfig, redactEnvironment, type UserConfig, validateEnvironment } from "@trawl/config"
import { validateKeybindings } from "@trawl/config/catalog"
import { type RuntimePaths, runtimePaths } from "./paths"
import { protectWindowsStorage } from "./windows-permissions"

export { type Connection, emptyConfig, type UserConfig } from "@trawl/config/catalog"

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("TRAWL storage must be a real directory")
  if (process.platform !== "win32") await chmod(path, 0o700)
  else await protectWindowsStorage(path, true)
}
export async function atomicJson(path: string, value: unknown) {
  await privateDirectory(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, "wx", 0o600)
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
export function validateConfig(raw: unknown): UserConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid configuration document")
  const config = raw as UserConfig
  if (config.version !== 1) throw new Error("Unsupported configuration version")
  const env = validateEnvironment(config.env)
  const desktop = { ...emptyConfig().desktop, ...config.desktop }
  if (
    !["ask", "tray", "quit"].includes(desktop.closeBehavior) ||
    !["immediate", "double-press", "hold"].includes(desktop.quitBehavior) ||
    !["dock-and-tray", "dock", "tray"].includes(desktop.appVisibility) ||
    typeof desktop.smoothScroll !== "boolean" ||
    typeof desktop.autostart !== "boolean" ||
    typeof desktop.startServerOnLaunch !== "boolean" ||
    !Array.isArray(desktop.connections) ||
    desktop.connections.length > 32
  )
    throw new Error("Invalid desktop preferences")
  if (typeof desktop.localName !== "string" || !desktop.localName.trim() || desktop.localName.length > 100)
    throw new Error("Invalid local instance name")
  if (
    !Array.isArray(desktop.instanceOrder) ||
    desktop.instanceOrder.length > 33 ||
    desktop.instanceOrder.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) ||
    new Set(desktop.instanceOrder).size !== desktop.instanceOrder.length
  )
    throw new Error("Invalid instance order")
  const ids = new Set<string>()
  for (const connection of desktop.connections) {
    if (
      !connection ||
      typeof connection.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(connection.id) ||
      ids.has(connection.id) ||
      connection.id === "local" ||
      typeof connection.name !== "string" ||
      !connection.name.trim() ||
      connection.name.length > 100
    )
      throw new Error("Invalid connection profile")
    ids.add(connection.id)
    let url: URL
    try {
      if (
        typeof connection.baseURL !== "string" ||
        connection.baseURL.length > 8192 ||
        /[\r\n\0]/.test(connection.baseURL)
      )
        throw new Error()
      url = new URL(connection.baseURL)
    } catch {
      throw new Error("Invalid connection URL")
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Connection URL must be HTTP(S) without credentials, query or fragment")
    if (
      connection.apiKey !== undefined &&
      (typeof connection.apiKey !== "string" || /[\r\n\0]/.test(connection.apiKey) || connection.apiKey.length > 8192)
    )
      throw new Error("Invalid connection key")
  }
  return {
    version: 1,
    env,
    desktop: {
      closeBehavior: desktop.closeBehavior,
      quitBehavior: desktop.quitBehavior,
      appVisibility: desktop.appVisibility,
      smoothScroll: desktop.smoothScroll,
      keybindings: validateKeybindings(desktop.keybindings),
      autostart: desktop.autostart,
      startServerOnLaunch: desktop.startServerOnLaunch,
      localName: desktop.localName.trim(),
      instanceOrder: desktop.instanceOrder,
      connections: desktop.connections.map(({ id, name, baseURL, apiKey }) => ({
        id,
        name,
        baseURL,
        ...(apiKey !== undefined ? { apiKey } : {}),
      })),
    },
  }
}
export async function readConfig(paths = runtimePaths()): Promise<UserConfig> {
  try {
    const info = await lstat(paths.config)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576)
      throw new Error("Configuration file is invalid or too large")
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      throw new Error("Configuration must be accessible only to its owner (chmod 600)")
    if (process.platform === "win32") await protectWindowsStorage(paths.config, false)
    let document: unknown
    try {
      document = JSON.parse(await readFile(paths.config, "utf8"))
    } catch {
      throw new Error("Configuration contains invalid JSON")
    }
    return validateConfig(document)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig()
    throw error
  }
}
export async function writeConfig(config: UserConfig, paths = runtimePaths()) {
  const checked = validateConfig(config)
  if (Buffer.byteLength(JSON.stringify(checked)) > 1048000) throw new Error("Configuration exceeds 1 MiB")
  await atomicJson(paths.config, checked)
}
export function publicConfig(config: UserConfig): UserConfig {
  return {
    ...config,
    env: redactEnvironment(config.env),
    desktop: {
      ...config.desktop,
      connections: config.desktop.connections.map(({ apiKey, ...connection }) => ({
        ...connection,
        ...(apiKey ? { apiKey: "[redacted]" } : {}),
      })),
    },
  }
}
export async function tailLog(paths: RuntimePaths = runtimePaths(), maxBytes = 65536): Promise<string> {
  try {
    const info = await stat(paths.log)
    const file = await open(paths.log, "r")
    try {
      const size = Math.min(info.size, maxBytes)
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await file.read(buffer, 0, size, Math.max(0, info.size - size))
      return buffer.subarray(0, bytesRead).toString("utf8")
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}
