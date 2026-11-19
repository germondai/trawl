import type { RequestDiagnostics, ScrapeRequest, ScrapeResult, TierResult } from "@trawl/types"

// Keep values and headers containing credentials in the bounded, authenticated capture store.
export function requestDiagnostics(
  req: ScrapeRequest,
  result?: ScrapeResult,
  attempts: TierResult[] = [],
  observedChallenge?: string,
): RequestDiagnostics {
  const type = (result?.contentType ?? result?.responseHeaders?.["content-type"])?.split(";")[0]?.trim().toLowerCase()
  const contentType =
    type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) && type.length <= 128 ? type : undefined
  const body = req.body
  const requestBodyBytes =
    body === undefined ? 0 : Buffer.byteLength(body, req.bodyEncoding === "base64" ? "base64" : "utf8")
  return {
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
    timings: (result?.timings ?? attempts)
      .slice(0, 8)
      .map(({ tier, status, durationMs }) => ({ tier, status, durationMs: Math.max(0, Math.round(durationMs)) })),
  }
}
