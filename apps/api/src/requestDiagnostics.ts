import type {
  ExecutionStage,
  FailureCause,
  RequestDiagnostics,
  ScrapeRequest,
  ScrapeResult,
  TierResult,
} from "@trawl/types"

const reasons = new Set([
  "cloudflare-challenge",
  "cloudflare-persistent",
  "javascript-shell",
  "session-content-needs-browser",
  "session-expired",
  "akamai-session-expired",
  "datadome-session-expired",
  "anubis-blocked",
  "anubis-challenge",
  "anubis-browser-closed",
  "anubis-solved",
  "anubis-failed",
  "anubis-timeout",
  "google-sorry-challenge",
  "duckduckgo-anomaly-challenge",
  "hcaptcha-shell",
  "recaptcha-shell",
  "turnstile-shell",
  "altcha-shell",
  "friendly-captcha-shell",
  "shumei-shell",
  "akamai-interstitial",
  "aws-waf-captcha-required",
  "aws-waf-challenge",
  "not-installed",
  "busy",
  "no-response",
  "failed",
  "ignore-certificate-errors-needs-fresh-context",
  "meta-refresh",
  "success-without-payload",
])
export function recordedReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  if (reasons.has(reason) || /^http-[1-5][0-9]{2}$/.test(reason)) return reason
  if (reason.startsWith("crossed-landing on ")) return "crossed-landing"
  if (reason === "browser network error (about:neterror)") return "browser-network-error"
  return undefined
}
export function failureCause(error: unknown, attempts: TierResult[] = [], status?: number): FailureCause {
  const terminal = attempts.at(-1)
  const message = error instanceof Error ? error.message.slice(0, 2048) : ""
  if (error instanceof Error && error.name === "PoolExhaustedError") return "capacity"
  if (terminal?.status === "blocked") {
    if (terminal.reason === "http-403" || terminal.reason === "http-429") return "suspected-security-block"
    return /^http-[45][0-9]{2}$/.test(terminal.reason ?? "") ? "http" : "security-block"
  }
  if (terminal?.status === "timeout" || /timeout|timed out|deadline/i.test(message)) return "timeout"
  if (/ECONN|ENOTFOUND|EAI_AGAIN|network|socket|TLS|neterror/i.test(message)) return "network"
  if (status === 403 || status === 429) return "suspected-security-block"
  if (status && status >= 400) return "http"
  if (terminal && terminal.tier >= 2) return "browser"
  return "internal"
}

// Keep values and headers containing credentials in the bounded, authenticated capture store.
export function requestDiagnostics(
  req: ScrapeRequest,
  result?: ScrapeResult,
  attempts: TierResult[] = [],
  observedChallenge?: string,
  context?: { startedAt: string; stages: ExecutionStage[]; operation?: "scrape" | "read" | "extract"; error?: unknown },
): RequestDiagnostics {
  const type = (result?.contentType ?? result?.responseHeaders?.["content-type"])?.split(";")[0]?.trim().toLowerCase()
  const contentType =
    type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) && type.length <= 128 ? type : undefined
  const body = req.body
  const requestBodyBytes =
    body === undefined ? 0 : Buffer.byteLength(body, req.bodyEncoding === "base64" ? "base64" : "utf8")
  const timings = result?.timings ?? attempts
  return {
    ...(context
      ? {
          startedAt: context.startedAt,
          operation: context.operation ?? "scrape",
          ...(req.sessionId && /^[A-Za-z0-9_-]{1,128}$/.test(req.sessionId) ? { sessionId: req.sessionId } : {}),
          stages: context.stages
            .slice(0, 32)
            .filter((stage) => Number.isFinite(stage.durationMs) && stage.durationMs >= 0)
            .map((stage) => ({
              kind: stage.kind,
              tier: stage.tier,
              startedAt: stage.startedAt,
              durationMs: Math.round(stage.durationMs),
              status: stage.status,
              ...(recordedReason(stage.reason) ? { reason: recordedReason(stage.reason) } : {}),
            })),
          ...(!result || result.statusCode >= 400
            ? { cause: failureCause(context.error, timings, result?.statusCode) }
            : {}),
          verification: [
            {
              check: "http-status" as const,
              status: !result
                ? ("skipped" as const)
                : result.statusCode >= 200 && result.statusCode < 400
                  ? ("passed" as const)
                  : ("failed" as const),
            },
            {
              check: "engine-outcome" as const,
              status: !timings.length
                ? ("skipped" as const)
                : timings.at(-1)?.status === "success" && result
                  ? ("passed" as const)
                  : ("failed" as const),
            },
            {
              check: "response-content" as const,
              status:
                !result || req.method === "HEAD" || result.statusCode === 204 || result.statusCode === 304
                  ? ("skipped" as const)
                  : (result.body?.byteLength ?? 0) > 0 || result.html.length > 0
                    ? ("passed" as const)
                    : ("failed" as const),
            },
          ],
        }
      : {}),
    requestBodyBytes,
    ...(result
      ? {
          responseBytes: result.body?.byteLength ?? Buffer.byteLength(result.html),
          contentType,
          responseKind: result.responseHeaders?.["content-disposition"]?.toLowerCase().startsWith("attachment")
            ? "file"
            : contentType === "text/event-stream" || contentType?.includes("mpegurl")
              ? "stream"
              : contentType?.includes("html")
                ? "html"
                : contentType?.includes("json")
                  ? "json"
                  : contentType?.startsWith("text/")
                    ? "text"
                    : result.body
                      ? "binary"
                      : "html",
        }
      : {}),
    challenges: [
      ...new Set(
        [
          ...(result?.captchasSolved ?? []),
          ...(result?.timings ?? attempts)
            .filter((attempt) => attempt.status === "blocked")
            .flatMap((attempt) => (attempt.reason ? [attempt.reason] : [])),
          ...(observedChallenge ? [observedChallenge] : []),
        ].map(
          (value) =>
            /^(turnstile|recaptcha(?:-v[23])?|hcaptcha|anubis|cloudflare)(?:$|[: -])/i
              .exec(value)?.[1]
              ?.toLowerCase() ?? "other",
        ),
      ),
    ].slice(0, 8),
    timings: timings.slice(0, 8).map(({ tier, status, durationMs, reason }) => ({
      tier,
      status,
      durationMs: Math.max(0, Math.round(durationMs)),
      ...(recordedReason(reason) ? { reason: recordedReason(reason) } : {}),
    })),
  }
}
