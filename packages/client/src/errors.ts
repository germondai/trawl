import type { BlockedEvidence, TierResult } from "../../types/src/api"
import { isRecord } from "./responses"
import type { TrawlErrorKind } from "./types"

export interface TrawlErrorDetails {
  kind: TrawlErrorKind
  status?: number
  data?: unknown
  retryAfter?: string
}

export class TrawlError extends Error {
  readonly kind: TrawlErrorKind
  readonly status: number | undefined
  readonly data: unknown
  readonly retryAfter: string | undefined
  readonly timings: TierResult[] | undefined
  readonly blockedEvidence: BlockedEvidence | undefined

  constructor(message: string, details: TrawlErrorDetails) {
    super(message)
    this.name = "TrawlError"
    this.kind = details.kind
    this.status = details.status
    this.data = details.data
    this.retryAfter = details.retryAfter
    const data = isRecord(details.data) ? details.data : undefined
    this.timings = Array.isArray(data?.timings) ? (data.timings as TierResult[]) : undefined
    this.blockedEvidence = isRecord(data?.blockedEvidence)
      ? (data.blockedEvidence as unknown as BlockedEvidence)
      : undefined
  }
}
