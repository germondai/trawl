import type { DashboardEvent, WafDetection } from "./api"

export interface InstanceCapabilities {
  version: 1
  authentication: "bearer"
  settings: boolean
  requests: boolean
  requestEvents: boolean
  logs: boolean
  logEvents: boolean
  captures: boolean
  browserInspection: boolean
  clientRequestIds?: boolean
}

export interface RequestHistoryEntry extends DashboardEvent {
  waf?: WafDetection
  id: string
  method: string | null
  tierStatus: string | null
}

export interface ActiveRequest {
  id: string
  startedAt: string
  domain: string
  source: string
  method: string
}

export type RequestLifecycle =
  | { type: "started"; request: ActiveRequest }
  | { type: "completed" | "failed"; request: RequestHistoryEntry; persisted: boolean }

export interface RequestHistoryResponse {
  entries: RequestHistoryEntry[]
  nextCursor: string | null
  cursor: string
  active: ActiveRequest[]
  activeTruncated: boolean
}

export interface ApplicationLog {
  at: string
  level: "error" | "warn" | "info" | "debug"
  scope: string
  message: string
}

export interface JournalEntry<T> {
  id: string
  data: T
}

export interface LogSnapshot {
  entries: JournalEntry<ApplicationLog>[]
  cursor: string
  coverage: "structured-application-logs-since-start"
}

export interface InstanceSetting {
  name: string
  group: string
  description: string
  kind: "boolean" | "integer" | "enum" | "string" | "json" | "ip"
  value: string | null
  source: "default" | "environment" | "normalized" | "runtime"
  secret: boolean
  configured?: boolean
}

export interface InstanceSettings {
  readOnly: true
  settings: InstanceSetting[]
}
