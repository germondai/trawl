import type { BrowserObservationSnapshot, ObservedBrowserPage } from "../../types/src/browserObservation"
import { isRecord } from "./responses"
import type { Transport } from "./transport"
import type { RequestOptions } from "./types"

const pageId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
function validPage(value: unknown): value is ObservedBrowserPage {
  if (!isRecord(value) || !pageId(value.id) || !integer(value.browserId, 0, Number.MAX_SAFE_INTEGER)) return false
  for (const key of ["requestId", "sessionId"] as const)
    if (value[key] !== undefined && (typeof value[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value[key])))
      return false
  if (value.source !== undefined && !["native", "flaresolverr", "mcp", "proxy"].includes(value.source as string))
    return false
  if (value.tier !== undefined && ![2, 3, 4].includes(value.tier as number)) return false
  if (
    !["headless", "host-window", "virtual-display"].includes(value.display as string) ||
    !["request", "session-idle", "session-busy"].includes(value.state as string)
  )
    return false
  if (
    typeof value.observedAt !== "string" ||
    value.observedAt.length > 32 ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    return false
  if (typeof value.origin !== "string" || value.origin.length > 512) return false
  if (value.origin !== "about:blank")
    try {
      const url = new URL(value.origin)
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== value.origin) return false
    } catch {
      return false
    }
  return true
}
function validSnapshot(value: unknown): value is BrowserObservationSnapshot {
  if (
    !isRecord(value) ||
    !Array.isArray(value.pages) ||
    value.pages.length > 128 ||
    !value.pages.every(validPage) ||
    typeof value.truncated !== "boolean"
  )
    return false
  if (new Set(value.pages.map((page) => page.id)).size !== value.pages.length) return false
  const limits = value.limits,
    headed = value.headedDebug
  return (
    isRecord(limits) &&
    integer(limits.width, 1, 1280) &&
    integer(limits.height, 1, 720) &&
    integer(limits.maxBytes, 1, 1048576) &&
    integer(limits.intervalMs, 1000, 60000) &&
    integer(limits.timeoutMs, 1, 2000) &&
    isRecord(headed) &&
    typeof headed.supported === "boolean" &&
    typeof headed.configured === "boolean" &&
    ["host-window", "virtual-display"].includes(headed.display as string)
  )
}

/** Observe already open pages; these operations never create or navigate a browser. */
export class BrowserObserver {
  constructor(private readonly transport: Transport) {}
  list(options: RequestOptions = {}): Promise<BrowserObservationSnapshot> {
    return this.transport.request("/browser/pages", options, validSnapshot)
  }
  preview(id: string, options: RequestOptions = {}): Promise<Uint8Array> {
    if (!pageId(id)) throw new TypeError("Invalid browser page ID")
    return this.transport.bytes(`/browser/pages/${id}/preview`, { timeoutMs: 5000, ...options }, 1048576)
  }
}
