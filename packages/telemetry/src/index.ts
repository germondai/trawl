import { isIP } from "node:net"

export const challenges = [
  "unknown",
  "none",
  "cloudflare",
  "turnstile",
  "recaptcha",
  "hcaptcha",
  "datadome",
  "akamai",
  "imperva",
  "aws-waf",
  "ddos-guard",
  "anubis",
  "altcha",
  "friendly-captcha",
] as const
export interface UsageEvent {
  domain: string
  challenge: (typeof challenges)[number]
  success: boolean
  durationMs: number
  version: string
}
const fields = ["domain", "challenge", "success", "durationMs", "version"]
function normalizedChallenge(value = ""): UsageEvent["challenge"] {
  const kind = value.toLowerCase().split(":", 1)[0] ?? ""
  if (kind.startsWith("recaptcha")) return "recaptcha"
  if (kind.startsWith("cloudflare")) return "cloudflare"
  return challenges.find((challenge) => kind === challenge || kind.startsWith(`${challenge}-`)) ?? "unknown"
}
function publicDomain(domain: unknown): domain is string {
  return (
    typeof domain === "string" &&
    domain.length <= 253 &&
    domain === domain.toLowerCase() &&
    !isIP(domain) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) &&
    !/\.(?:local|localhost|internal|test|invalid|onion|home|lan|arpa)$/.test(domain)
  )
}
export function validUsageEvent(input: unknown): input is UsageEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const item = input as Record<string, unknown>
  return (
    Object.keys(item).length === fields.length &&
    Object.keys(item).every((key) => fields.includes(key)) &&
    publicDomain(item.domain) &&
    challenges.includes(item.challenge as UsageEvent["challenge"]) &&
    typeof item.success === "boolean" &&
    Number.isInteger(item.durationMs) &&
    Number(item.durationMs) >= 0 &&
    Number(item.durationMs) <= 600000 &&
    typeof item.version === "string" &&
    /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.-]{1,24})?$/.test(item.version)
  )
}
export function usageEvent(input: {
  url: string
  challenge?: string
  success: boolean
  durationMs: number
  version: string
}): UsageEvent | undefined {
  let domain: string
  try {
    const url = new URL(input.url)
    if (!["http:", "https:"].includes(url.protocol)) return
    domain = url.hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return
  }
  const event: UsageEvent = {
    domain,
    challenge: normalizedChallenge(input.challenge),
    success: input.success,
    durationMs: Math.min(600000, Math.max(0, Math.round(input.durationMs / 10) * 10)),
    version: input.version,
  }
  return validUsageEvent(event) ? event : undefined
}
export function usageBatch(raw: unknown): UsageEvent[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).join(",") !== "events") return
  const events = (raw as { events: unknown }).events
  return Array.isArray(events) && events.length > 0 && events.length <= 20 && events.every(validUsageEvent)
    ? events
    : undefined
}
export function telemetryEndpoint(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("TELEMETRY_ENDPOINT requires an HTTPS URL without credentials, query or fragment")
  return url.href
}
export function usageReporter(options: {
  enabled: boolean
  endpoint: string
  version: string
  fetch?: typeof fetch
  intervalMs?: number
}) {
  const queue: UsageEvent[] = []
  let closed = false,
    busy = false
  const endpoint = options.enabled ? telemetryEndpoint(options.endpoint) : ""
  const transport = options.fetch ?? fetch
  let active: AbortController | undefined
  async function flush() {
    if (closed || !endpoint || busy || !queue.length) return
    busy = true
    const controller = new AbortController()
    active = controller
    const body = JSON.stringify({ events: queue.splice(0, 20) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = Promise.resolve()
      .then(() =>
        transport(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        }),
      )
      .then((response) => response.body?.cancel())
      .catch(() => {})
      .finally(() => {
        busy = false
        active = undefined
      })
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve()
        }, 2000)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
  }
  const timer = endpoint
    ? setInterval(() => {
        void flush()
      }, options.intervalMs ?? 60000)
    : undefined
  timer?.unref?.()
  return {
    record(input: Omit<Parameters<typeof usageEvent>[0], "version">) {
      if (!endpoint || closed || queue.length >= 100) return
      const event = usageEvent({ ...input, version: options.version })
      if (event) queue.push(event)
    },
    flush,
    close() {
      closed = true
      queue.length = 0
      clearInterval(timer)
      active?.abort()
    },
  }
}
