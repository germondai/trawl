export interface ObservedBrowserPage {
  id: string
  requestId?: string
  sessionId?: string
  source?: "native" | "flaresolverr" | "mcp" | "proxy"
  tier?: 2 | 3 | 4
  browserId: number
  display: "headless" | "host-window" | "virtual-display"
  state: "request" | "session-idle" | "session-busy"
  origin: string
  observedAt: string
}

export interface BrowserObservationSnapshot {
  pages: ObservedBrowserPage[]
  truncated: boolean
  limits: { width: number; height: number; maxBytes: number; intervalMs: number; timeoutMs: number }
  headedDebug: { supported: boolean; configured: boolean; display: "host-window" | "virtual-display" }
}
