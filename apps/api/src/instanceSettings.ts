import { settings } from "@trawl/config/catalog"
import { effectiveCaptureSettings, sttSettings, TIER1_TRANSPORT } from "@trawl/tiers"
import type { InstanceSettings } from "@trawl/types"
import * as config from "./config"
import { LOG_LEVEL } from "./logger"

const values: Record<string, unknown> = {
  ...config,
  ...effectiveCaptureSettings,
  ...sttSettings,
  TIER1_TRANSPORT,
  LOG_LEVEL,
  BROWSER_POOL_SIZE: config.POOL_SIZE,
  BROWSER_ACQUIRE_TIMEOUT_MS: config.ACQUIRE_TIMEOUT_MS,
  BROWSER_RECYCLE_AFTER_CONTEXTS: config.RECYCLE_AFTER_TEMPORARY_CONTEXTS,
  BROWSER_HEADFUL_POOL_SIZE: config.HEADFUL_POOL_SIZE,
  BROWSER_STALL_TIMEOUT_MS: config.STALL_TIMEOUT_MS,
  BROWSER_CLOSE_TIMEOUT_MS: config.CLOSE_TIMEOUT_MS,
  BROWSER_SHUTDOWN_DRAIN_MS: config.SHUTDOWN_DRAIN_MS,
  BROWSER_LAUNCH_TIMEOUT_MS: config.LAUNCH_TIMEOUT_MS,
  MCP_ALLOWED_ORIGINS: config.MCP_ALLOWED_ORIGINS.join(","),
  FFMPEG_PATH: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  PROXY_LIST_FILE: process.env.PROXY_LIST_FILE?.trim() || "",
  RESIDENTIAL_PROXY_LIST_FILE: process.env.RESIDENTIAL_PROXY_LIST_FILE?.trim() || "",
  CAPTCHA_SOLVER: config.EXTERNAL_CAPTCHA ? "2captcha" : "none",
  CAPTCHA_SOLVER_MAX_TASKS: config.EXTERNAL_CAPTCHA?.maxTasks ?? 1,
  CAPTCHA_SOLVER_TIMEOUT_MS: config.EXTERNAL_CAPTCHA?.timeoutMs ?? 120_000,
  CAPTCHA_SOLVER_LOCAL_TIMEOUT_MS: config.EXTERNAL_CAPTCHA?.localTimeoutMs ?? 10_000,
}

// USER_PREFS can contain proxy credentials; a custom STT URL can include a private key.
const sensitive = new Set(["USER_PREFS", "STT_URL"])
const snapshot: InstanceSettings = {
  readOnly: true,
  settings: settings.map(({ name, group, description, kind, secret: hidden }) => {
    const raw = process.env[name]
    const secret = Boolean(hidden || sensitive.has(name))
    const base = { name, group, description, kind, secret }
    if (secret)
      return { ...base, value: null, source: raw ? "environment" : "default", configured: Boolean(raw?.trim()) }
    if (!(name in values)) throw new Error(`Missing effective setting: ${name}`)
    const used = values[name]
    if (used !== undefined && !["string", "number", "boolean"].includes(typeof used))
      throw new Error(`Unsupported effective setting: ${name}`)
    const value = used === undefined ? "" : String(used)
    return {
      ...base,
      value,
      source: raw === undefined ? "default" : raw.trim() === value ? "environment" : "normalized",
    }
  }),
}

export function readInstanceSettings(): InstanceSettings {
  return snapshot
}
