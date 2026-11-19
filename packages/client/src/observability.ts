import type {
  ActiveRequest,
  ApplicationLog,
  InstanceCapabilities,
  InstanceSettings,
  LogSnapshot,
  RequestHistoryEntry,
  RequestHistoryQuery,
  RequestHistoryResponse,
  RequestLifecycle,
} from "../../types/src/observability"
import { isRecord, isWafDetection } from "./responses"
import type { StreamEvent, StreamOptions } from "./stream"
import { validStreamCursor } from "./stream"
import type { Transport } from "./transport"
import type { RequestOptions } from "./types"

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const boundedString = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum
const size = (value: unknown) => number(value) && Number.isSafeInteger(value)
const date = (value: unknown) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
const isCaptures = (value: unknown): value is RequestCaptures =>
  isRecord(value) &&
  boundedString(value.requestId, 80) &&
  date(value.requestAt) &&
  typeof value.mode === "string" &&
  ["none", "html", "screenshot", "both"].includes(value.mode) &&
  Array.isArray(value.artifacts) &&
  value.artifacts.length <= 3 &&
  (value.mode !== "none" || value.artifacts.every((item) => isRecord(item) && item.kind === "request")) &&
  new Set(value.artifacts.map((item) => (isRecord(item) ? item.kind : null))).size === value.artifacts.length &&
  value.artifacts.every(
    (item) =>
      isRecord(item) &&
      typeof item.kind === "string" &&
      ["html", "screenshot", "request"].includes(item.kind) &&
      typeof item.state === "string" &&
      ["pending", "ready", "unavailable", "too-large", "expired", "failed"].includes(item.state) &&
      (item.bytes === undefined || size(item.bytes)) &&
      (item.storedBytes === undefined || size(item.storedBytes)) &&
      (item.reason === undefined || boundedString(item.reason, 80)) &&
      (item.capturedAt === undefined || date(item.capturedAt)) &&
      (item.contentType === undefined || boundedString(item.contentType, 128)) &&
      (item.sha256 === undefined || (typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256))) &&
      (item.encoding === undefined ||
        (typeof item.encoding === "string" && ["identity", "gzip"].includes(item.encoding))) &&
      (item.truncated === undefined || typeof item.truncated === "boolean") &&
      (item.state !== "ready" ||
        (size(item.bytes) &&
          Number(item.bytes) <= 8388608 &&
          size(item.storedBytes) &&
          Number(item.storedBytes) <= 8388608 &&
          typeof item.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(item.sha256) &&
          boundedString(item.contentType, 128) &&
          boundedString(item.capturedAt, 64) &&
          typeof item.encoding === "string" &&
          ["identity", "gzip"].includes(item.encoding))),
  )
export const isCapabilities = (value: unknown): value is InstanceCapabilities =>
  isRecord(value) &&
  value.version === 1 &&
  value.authentication === "bearer" &&
  (value.clientRequestIds === undefined || typeof value.clientRequestIds === "boolean") &&
  (value.requestQuery === undefined || typeof value.requestQuery === "boolean") &&
  (value.requestOptions === undefined ||
    (isRecord(value.requestOptions) &&
      typeof value.requestOptions.binaryBodies === "boolean" &&
      typeof value.requestOptions.targetAuth === "boolean")) &&
  ["settings", "requests", "requestEvents", "logs", "logEvents", "captures", "browserInspection"].every(
    (key) => typeof value[key] === "boolean",
  )
export const isSettings = (value: unknown): value is InstanceSettings =>
  isRecord(value) &&
  value.readOnly === true &&
  Array.isArray(value.settings) &&
  value.settings.every(
    (item) =>
      isRecord(item) &&
      [item.name, item.group, item.description, item.kind, item.source].every((value) => typeof value === "string") &&
      typeof item.secret === "boolean" &&
      (item.secret ? item.value === null && typeof item.configured === "boolean" : typeof item.value === "string"),
  )
export const isHistoryEntry = (value: unknown): value is RequestHistoryEntry =>
  isRecord(value) &&
  [value.id, value.at, value.domain, value.source].every((value) => typeof value === "string") &&
  number(value.durationMs) &&
  typeof value.success === "boolean" &&
  (value.method === null || typeof value.method === "string") &&
  [value.statusCode, value.tier].every((value) => value === null || number(value)) &&
  [value.category, value.severity, value.tierStatus].every((value) => value === null || typeof value === "string") &&
  (value.waf === undefined || isWafDetection(value.waf)) &&
  (value.diagnostics === undefined ||
    (isRecord(value.diagnostics) &&
      [value.diagnostics.requestBodyBytes, value.diagnostics.responseBytes].every(
        (value) => value === undefined || size(value),
      ) &&
      (value.diagnostics.contentType === undefined || boundedString(value.diagnostics.contentType, 128)) &&
      (value.diagnostics.responseKind === undefined ||
        ["html", "json", "text", "file", "stream", "binary"].includes(String(value.diagnostics.responseKind))) &&
      Array.isArray(value.diagnostics.challenges) &&
      value.diagnostics.challenges.length <= 8 &&
      value.diagnostics.challenges.every((value) => boundedString(value, 40)) &&
      Array.isArray(value.diagnostics.timings) &&
      value.diagnostics.timings.length <= 8 &&
      value.diagnostics.timings.every(
        (value) => isRecord(value) && number(value.tier) && boundedString(value.status, 40) && number(value.durationMs),
      )))
const isActive = (value: unknown): value is ActiveRequest =>
  isRecord(value) &&
  [value.id, value.startedAt, value.domain, value.source, value.method].every((value) => typeof value === "string")
export const isRequestLifecycle = (value: unknown): value is RequestLifecycle =>
  isRecord(value) &&
  (value.type === "started"
    ? isActive(value.request)
    : (value.type === "completed" || value.type === "failed") &&
      typeof value.persisted === "boolean" &&
      isHistoryEntry(value.request))
export const isHistory = (value: unknown): value is RequestHistoryResponse =>
  isRecord(value) &&
  (value.total === undefined || size(value.total)) &&
  (value.page === undefined || size(value.page)) &&
  Array.isArray(value.entries) &&
  value.entries.every(isHistoryEntry) &&
  (value.nextCursor === null || typeof value.nextCursor === "string") &&
  typeof value.cursor === "string" &&
  validStreamCursor(value.cursor) &&
  Array.isArray(value.active) &&
  value.active.every(isActive) &&
  typeof value.activeTruncated === "boolean"
export const isApplicationLog = (value: unknown): value is ApplicationLog =>
  isRecord(value) &&
  [value.at, value.scope, value.message].every((value) => typeof value === "string") &&
  typeof value.level === "string" &&
  ["error", "warn", "info", "debug"].includes(value.level)
const isLogs = (value: unknown): value is LogSnapshot =>
  isRecord(value) &&
  typeof value.cursor === "string" &&
  validStreamCursor(value.cursor) &&
  value.coverage === "structured-application-logs-since-start" &&
  Array.isArray(value.entries) &&
  value.entries.every(
    (entry) =>
      isRecord(entry) && typeof entry.id === "string" && validStreamCursor(entry.id) && isApplicationLog(entry.data),
  )

export class Requests {
  constructor(private readonly transport: Transport) {}
  list(
    query: RequestHistoryQuery & { limit?: number; before?: string } = {},
    options: RequestOptions = {},
  ): Promise<RequestHistoryResponse> {
    const params = new URLSearchParams()
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
        throw new TypeError("limit must be from 1 to 100")
      params.set("limit", String(query.limit))
    }
    if (query.before !== undefined) {
      validateId(query.before)
      params.set("before", query.before)
    }
    if (query.page !== undefined) {
      if (!Number.isInteger(query.page) || query.page < 1 || query.page > 50000)
        throw new TypeError("page must be from 1 to 50000")
      params.set("page", String(query.page))
    }
    if (query.search !== undefined) {
      if (query.search.length > 200 || /\p{Cc}/u.test(query.search)) throw new TypeError("Invalid history search")
      params.set("search", query.search)
    }
    for (const [name, allowed] of [
      ["source", ["native", "flaresolverr", "mcp", "proxy"]],
      ["result", ["success", "failed"]],
      ["sort", ["newest", "oldest", "slowest", "fastest"]],
    ] as const) {
      const value = query[name]
      if (value === undefined) continue
      if (!(allowed as readonly string[]).includes(value)) throw new TypeError(`Invalid history ${name}`)
      params.set(name, value)
    }
    if (query.tier !== undefined) {
      if (!Number.isInteger(query.tier) || query.tier < 0 || query.tier > 4) throw new TypeError("Invalid history tier")
      params.set("tier", String(query.tier))
    }
    if (query.before !== undefined && [...params.keys()].some((name) => name !== "before" && name !== "limit"))
      throw new TypeError("before cannot be combined with history query filters")
    return this.transport.request(`/requests${params.size ? `?${params}` : ""}`, options, isHistory)
  }
  get(id: string, options: RequestOptions = {}): Promise<RequestHistoryEntry> {
    validateId(id)
    return this.transport.request(`/requests/${id}`, options, isHistoryEntry)
  }
  captures(id: string, options: RequestOptions = {}): Promise<RequestCaptures> {
    validateId(id)
    return this.transport.request(
      `/requests/${id}/captures`,
      options,
      (value): value is RequestCaptures => isCaptures(value) && value.requestId === id,
    )
  }
  artifact(id: string, kind: ArtifactKind, options: RequestOptions = {}): Promise<Uint8Array> {
    validateId(id)
    if (!["html", "screenshot", "request"].includes(kind)) throw new TypeError("Invalid artifact kind")
    return this.transport.bytes(`/requests/${id}/captures/${kind}`, options)
  }
  events(options: StreamOptions = {}): AsyncGenerator<StreamEvent<RequestLifecycle>> {
    return this.transport.events("/requests/events", options, isRequestLifecycle)
  }
}

export class Logs {
  constructor(private readonly transport: Transport) {}
  list(limit = 100, options: RequestOptions = {}): Promise<LogSnapshot> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError("limit must be from 1 to 500")
    return this.transport.request(`/logs?limit=${limit}`, options, isLogs)
  }
  events(options: StreamOptions = {}): AsyncGenerator<StreamEvent<ApplicationLog>> {
    return this.transport.events("/logs/events", options, isApplicationLog)
  }
}

function validateId(value: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new TypeError("Invalid request ID")
}

import type { ArtifactKind, RequestCaptures } from "../../types/src/artifacts"
