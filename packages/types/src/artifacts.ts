import type { Cookie } from "./api"

export type CaptureMode = "none" | "html" | "screenshot" | "both"
export type ArtifactKind = "html" | "screenshot" | "request"

export interface CapturedRequest {
  version: 1
  source: string
  operation: "scrape" | "read" | "extract" | "eval"
  parameters: Record<string, unknown>
  bodyEncoding?: "base64"
  response?: {
    headers?: Record<string, string>
    cookies?: Cookie[]
  }
}
export type ArtifactState = "pending" | "ready" | "unavailable" | "too-large" | "expired" | "failed"

export interface RequestArtifact {
  kind: ArtifactKind
  state: ArtifactState
  capturedAt?: string
  contentType?: string
  bytes?: number
  storedBytes?: number
  sha256?: string
  encoding?: "identity" | "gzip"
  reason?: string
  truncated?: boolean
}

export interface RequestCaptures {
  requestId: string
  requestAt: string
  mode: CaptureMode
  artifacts: RequestArtifact[]
}

export interface CapturedMarkdown {
  text: string
  truncated: boolean
}
