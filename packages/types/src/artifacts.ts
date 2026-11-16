export type CaptureMode = "none" | "html" | "screenshot" | "both"
export type ArtifactKind = "html" | "screenshot"
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
