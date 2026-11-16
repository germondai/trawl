import type { ApplicationLog } from "@trawl/types"
import { OBSERVABILITY_ENABLED } from "./config"
import { EventJournal } from "./eventJournal"

export const applicationLogs = new EventJournal<ApplicationLog>()

// Free-form errors, headers and bodies remain private stdout; the remote stream exposes metadata only.
const fields = new Set([
  "event",
  "request",
  "source",
  "method",
  "statusCode",
  "tier",
  "status",
  "totalMs",
  "durationMs",
  "bytes",
  "cookies",
  "maxTier",
  "proxy",
  "proxyUsed",
  "timeoutMs",
  "sessionCached",
  "wafState",
  "wafReason",
  "port",
  "poolSize",
  "limitMiB",
  "recommendedMiB",
  "newKills",
  "totalKills",
  "currentMiB",
  "driver",
  "retryDelayMs",
  "errorKind",
  "state",
])

export function recordApplicationLog(
  level: ApplicationLog["level"],
  scope: string,
  values: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!OBSERVABILITY_ENABLED) return
  const metadata: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!fields.has(key) || value === undefined) continue
    // String metadata is restricted to identifiers, never arbitrary diagnostic text.
    if (typeof value === "string" && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) continue
    metadata[key] = value
  }
  applicationLogs.publish({
    at: new Date().toISOString(),
    level,
    scope: /^[a-zA-Z0-9_.:-]{1,64}$/.test(scope) ? scope : "application",
    message: Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}`)
      .join(" "),
  })
}
