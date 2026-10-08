import type {
  CapturedResponseEntry,
  ConsoleLogEntry,
  Cookie,
  FaviconEntry,
  NetworkLogEntry,
  TierResult,
} from "@trawl/types"

export interface BrowserTierResult<T extends 2 | 3 | 4> extends TierResult {
  tier: T
  challenge?: "datadome"
  effectiveUrl?: string
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  cookies?: Cookie[]
  userAgent?: string
  statusCode?: number
  captchasSolved?: string[]
  screenshot?: string
  favicons?: FaviconEntry[]
  consoleLogs?: ConsoleLogEntry[]
  networkLogs?: NetworkLogEntry[]
  redirectChain?: string[]
  capturedResponses?: CapturedResponseEntry[]
  mhtml?: string
}
