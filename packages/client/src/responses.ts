import type {
  BrowserSession,
  Cookie,
  DashboardSnapshot,
  ExtractResponse,
  HealthResponse,
  PageMetadata,
  ReadResponse,
  ScrapeResponse,
  ServerInfoResponse,
  StatsResponse,
  WafDetection,
} from "../../types/src/api"

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const positiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
const label = (value: unknown): value is string => typeof value === "string" && value.length <= 256
const requestId = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value))
export const isWafDetection = (value: unknown): value is WafDetection =>
  isRecord(value) &&
  value.engine === "wafmeow" &&
  label(value.version) &&
  typeof value.state === "string" &&
  ["complete", "incomplete", "unavailable"].includes(value.state) &&
  Array.isArray(value.products) &&
  value.products.length <= 256 &&
  value.products.every(label) &&
  (value.sourceTier === undefined ||
    (typeof value.sourceTier === "number" && [1, 2, 3, 4].includes(value.sourceTier))) &&
  (value.durationMs === undefined || positiveNumber(value.durationMs)) &&
  (value.reason === undefined ||
    (typeof value.reason === "string" &&
      ["not-installed", "timeout", "busy", "failed", "no-response"].includes(value.reason))) &&
  (value.detailsTruncated === undefined || typeof value.detailsTruncated === "boolean") &&
  (value.incompleteProducts === undefined ||
    (Array.isArray(value.incompleteProducts) &&
      value.incompleteProducts.length <= 256 &&
      value.incompleteProducts.every(label))) &&
  (value.matches === undefined ||
    (Array.isArray(value.matches) &&
      value.matches.length <= 32 &&
      value.matches.every(
        (match) =>
          isRecord(match) &&
          label(match.product) &&
          typeof match.schema === "number" &&
          Number.isSafeInteger(match.schema) &&
          match.schema >= 1 &&
          Array.isArray(match.fingerprints) &&
          match.fingerprints.length <= 16 &&
          match.fingerprints.every(
            (ref) =>
              isRecord(ref) &&
              typeof ref.fingerprint === "number" &&
              Number.isSafeInteger(ref.fingerprint) &&
              ref.fingerprint >= 1 &&
              ref.evidence === 0,
          ),
      ))) &&
  (value.diagnostics === undefined ||
    (Array.isArray(value.diagnostics) &&
      value.diagnostics.length <= 16 &&
      value.diagnostics.every(
        (item) =>
          isRecord(item) &&
          typeof item.code === "string" &&
          ["body_truncated", "missing_response", "invalid_engine", "invalid_evidence", "transport_error"].includes(
            item.code,
          ) &&
          (item.evidence === 0 || item.evidence === -1),
      )))

export const isDashboardSnapshot = (value: unknown): value is DashboardSnapshot =>
  isRecord(value) &&
  (value.maximumMs === undefined || positiveNumber(value.maximumMs)) &&
  ["requests", "successes", "failures", "averageMs", "rangeMinutes", "retainedEvents", "bucketMs"].every((key) =>
    positiveNumber(value[key]),
  ) &&
  (value.startedAt === null || typeof value.startedAt === "string") &&
  isRecord(value.bySource) &&
  Object.values(value.bySource).every(positiveNumber) &&
  isRecord(value.byTier) &&
  Object.values(value.byTier).every(
    (tier) => isRecord(tier) && positiveNumber(tier.attempts) && positiveNumber(tier.successes),
  ) &&
  Array.isArray(value.timeline) &&
  value.timeline.every(
    (row) =>
      isRecord(row) &&
      typeof row.minute === "string" &&
      [row.requests, row.failures, row.averageMs].every(positiveNumber),
  ) &&
  Array.isArray(value.domains) &&
  value.domains.every(
    (row) => isRecord(row) && typeof row.domain === "string" && [row.requests, row.failures].every(positiveNumber),
  ) &&
  Array.isArray(value.recentEvents) &&
  value.recentEvents.every(
    (row) =>
      isRecord(row) &&
      [row.at, row.domain, row.source].every((value) => typeof value === "string") &&
      positiveNumber(row.durationMs) &&
      typeof row.success === "boolean" &&
      [row.tier, row.statusCode].every((value) => value === null || positiveNumber(value)) &&
      [row.category, row.severity].every((value) => value === null || typeof value === "string"),
  )

export const isSession = (value: unknown): value is BrowserSession =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.createdAt === "number" &&
  typeof value.expiresAt === "number" &&
  typeof value.busy === "boolean" &&
  typeof value.keepPage === "boolean"

export const isCookie = (value: unknown): value is Cookie =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.value === "string" &&
  typeof value.domain === "string" &&
  typeof value.path === "string" &&
  typeof value.expires === "number" &&
  typeof value.httpOnly === "boolean" &&
  typeof value.secure === "boolean"

export const isScrapeResponse = (value: unknown): value is ScrapeResponse =>
  isRecord(value) &&
  requestId(value.requestId) &&
  typeof value.url === "string" &&
  typeof value.html === "string" &&
  typeof value.statusCode === "number" &&
  typeof value.userAgent === "string" &&
  typeof value.tier === "number" &&
  [1, 2, 3, 4].includes(value.tier) &&
  typeof value.sessionCached === "boolean" &&
  typeof value.totalMs === "number" &&
  Array.isArray(value.cookies) &&
  value.cookies.every(isCookie) &&
  Array.isArray(value.timings)

export const isServerInfo = (value: unknown): value is ServerInfoResponse =>
  isRecord(value) &&
  typeof value.msg === "string" &&
  typeof value.version === "string" &&
  typeof value.uptime === "number"

export const isHealth = (value: unknown): value is HealthResponse =>
  isRecord(value) &&
  (value.status === "ok" || value.status === "starting") &&
  typeof value.uptime === "number" &&
  isRecord(value.pool)

export const isStats = (value: unknown): value is StatsResponse =>
  isRecord(value) && typeof value.browsers === "number" && (value.headful === null || isRecord(value.headful))

const isPageMetadata = (value: unknown): value is PageMetadata =>
  isRecord(value) &&
  requestId(value.requestId) &&
  typeof value.url === "string" &&
  typeof value.statusCode === "number" &&
  typeof value.tier === "number" &&
  [1, 2, 3, 4].includes(value.tier) &&
  typeof value.contentType === "string" &&
  typeof value.totalMs === "number"

export const isReadResponse = (value: unknown): value is ReadResponse =>
  isPageMetadata(value) &&
  isRecord(value) &&
  typeof value.text === "string" &&
  typeof value.title === "string" &&
  ["markdown", "text"].includes(String(value.format)) &&
  typeof value.characters === "number" &&
  typeof value.truncated === "boolean"

export const isExtractResponse = (value: unknown): value is ExtractResponse =>
  isPageMetadata(value) &&
  isRecord(value) &&
  typeof value.matched === "number" &&
  typeof value.truncated === "boolean" &&
  Array.isArray(value.items) &&
  value.items.every(
    (item) => isRecord(item) && Object.values(item).every((value) => value === null || typeof value === "string"),
  )
