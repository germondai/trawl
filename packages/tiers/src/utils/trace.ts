import type { ExecutionStage } from "@trawl/types"

export async function traceStage<T>(
  kind: ExecutionStage["kind"],
  run: () => Promise<T>,
  observe?: (stage: ExecutionStage) => void,
  tier?: number,
): Promise<T> {
  if (!observe) return run()
  const startedAt = new Date().toISOString()
  const start = performance.now()
  let status = "error"
  let reason: string | undefined
  try {
    const result = await run()
    const details = result as { status?: unknown; state?: unknown; reason?: unknown } | undefined
    status =
      typeof details?.status === "string"
        ? details.status
        : typeof details?.state === "string"
          ? details.state
          : "success"
    reason = typeof details?.reason === "string" ? details.reason : undefined
    return result
  } finally {
    try {
      observe({ kind, tier, startedAt, durationMs: Math.max(0, performance.now() - start), status, reason })
    } catch {
      // Observability must not change the operation's result or error.
    }
  }
}
