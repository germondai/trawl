import { randomUUID } from "node:crypto"

export type LogLevel = "error" | "warn" | "info" | "debug" | "silent"
type LogValue = string | number | boolean | null | undefined

const ranks: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, silent: -1 }

export function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value?.trim().toLowerCase() || "info") as LogLevel
  if (level in ranks) return level
  throw new Error(`Invalid LOG_LEVEL ${JSON.stringify(value)}; expected error, warn, info, debug, or silent`)
}

export const LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL)

const quote = (value: LogValue): string => {
  if (value === null) return "null"
  if (value === undefined) return ""
  if (typeof value !== "string") return String(value)
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value)
}

export function safeUrl(candidate: string): string {
  try {
    const url = new URL(candidate)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return "<unparseable-url>"
  }
}

export function safeMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => safeUrl(candidate))
}

export function requestId(): string {
  return randomUUID().slice(0, 8)
}

export function log(level: Exclude<LogLevel, "silent">, scope: string, fields: Record<string, LogValue>): void {
  if (LOG_LEVEL === "silent" || ranks[level] > ranks[LOG_LEVEL]) return
  const line = [`level=${level}`, `scope=${scope}`]
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line.push(`${key}=${quote(value)}`)
  }
  const message = line.join(" ")
  if (level === "error") console.error(message)
  else if (level === "warn") console.warn(message)
  else console.log(message)
}
