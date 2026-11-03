import type {
  BrowserSession,
  Cookie,
  ExtractResponse,
  HealthResponse,
  PageMetadata,
  ReadResponse,
  ScrapeResponse,
  ServerInfoResponse,
  StatsResponse,
} from "../../types/src/api"

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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
