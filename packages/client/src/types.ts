import type {
  ConsoleLogEntry,
  ExtractRequest as NativeExtractRequest,
  ReadRequest as NativeReadRequest,
  ScrapeRequest as NativeScrapeRequest,
  NetworkLogEntry,
  ScrapeResponse,
} from "../../types/src/api"

type ClientRequest<T> = Omit<T, "body"> & { body?: string | object }
export type ScrapeRequest = ClientRequest<NativeScrapeRequest>
export type ReadRequest = ClientRequest<NativeReadRequest>
export type ExtractRequest = ClientRequest<NativeExtractRequest>

export interface TrawlOptions {
  baseURL?: string
  apiKey?: string
  headers?: RequestInit["headers"]
  timeoutMs?: number
  fetch?: Fetch
}

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface EvalOptions extends RequestOptions {
  maxTimeout?: number
}

export type TrawlErrorKind = "api" | "network" | "timeout" | "aborted" | "protocol"
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ScreenshotRequest extends Omit<ScrapeRequest, "maxTier" | "skipHttp" | "screenshot"> {
  maxTier?: 2 | 3 | 4
}

export interface ScreenshotResponse extends ScrapeResponse {
  screenshot: string
}

export interface InspectRequest
  extends Omit<ScrapeRequest, "maxTier" | "skipHttp" | "consoleLogs" | "networkLogs" | "redirectChain"> {
  maxTier?: 2 | 3 | 4
}

export interface InspectResponse extends ScrapeResponse {
  consoleLogs: ConsoleLogEntry[]
  networkLogs: NetworkLogEntry[]
  redirectChain: string[]
}
