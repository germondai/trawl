import type { DashboardEvent, WafDetection } from "./api"

export interface InstanceCapabilities {
  version: 1
  authentication: "bearer"
  settings: boolean
  requests: boolean
  requestEvents: boolean
  requestQuery?: boolean
  logs: boolean
  logEvents: boolean
  captures: boolean
  browserInspection: boolean
  clientRequestIds?: boolean
  requestOptions?: { binaryBodies: boolean; targetAuth: boolean }
  mcp?: { enabled: boolean }
  sessionActivity?: boolean
  sessionActivityRequestIds?: boolean
  sessionActivityPagination?: boolean
  captureMarkdown?: boolean
}

export interface SessionActivityPage {
  entries: SessionActivity[]
  total: number
  page: number
}

export interface ExecutionStage {
  kind: "tier" | "browser-acquire" | "session-cache" | "waf-detection" | "capture"
  tier?: number
  startedAt: string
  durationMs: number
  status: string
  reason?: string
}
export type FailureCause =
  | "browser"
  | "timeout"
  | "network"
  | "http"
  | "security-block"
  | "suspected-security-block"
  | "capacity"
  | "internal"
export interface SessionActivity {
  id: string
  at: string
  sessionId: string
  /** Request that produced the page this script ran against; absent on older records. */
  requestId?: string
  operation: "eval"
  durationMs: number
  success: boolean
  cause?: FailureCause
  scriptBytes: number
  scriptHash: string
}

export interface RequestDiagnostics {
  requestBodyBytes?: number
  responseBytes?: number
  contentType?: string
  responseKind?: "html" | "json" | "text" | "file" | "stream" | "binary"
  challenges: string[]
  timings: { tier: number; status: string; durationMs: number; reason?: string }[]
  startedAt?: string
  sessionId?: string
  operation?: "scrape" | "read" | "extract"
  stages?: ExecutionStage[]
  cause?: FailureCause
  verification?: {
    check: "http-status" | "engine-outcome" | "response-content"
    status: "passed" | "failed" | "skipped"
  }[]
}

export interface RequestHistoryEntry extends DashboardEvent {
  diagnostics?: RequestDiagnostics
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

export interface RequestHistoryQuery {
  page?: number
  search?: string
  source?: "native" | "flaresolverr" | "mcp" | "proxy"
  result?: "success" | "failed"
  tier?: number
  sort?: "newest" | "oldest" | "slowest" | "fastest"
}

export interface RequestHistoryResponse {
  total?: number
  page?: number
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
