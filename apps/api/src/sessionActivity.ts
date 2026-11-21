import { createHash, randomUUID } from "node:crypto"
import type { SessionActivity } from "@trawl/types"
import type { CaptureStore } from "./captureStore"
import { captureRequestInput } from "./historyCapture"
import type { MetricsStore } from "./metrics"
import { failureCause } from "./requestDiagnostics"

export async function recordSessionEval<T>(
  store: MetricsStore,
  captures: CaptureStore | undefined,
  sessionId: string,
  expression: string,
  run: () => Promise<T>,
  pageRequestId?: () => string | undefined,
): Promise<T> {
  const at = new Date().toISOString()
  const started = performance.now()
  const id = randomUUID()
  const scriptBytes = Buffer.byteLength(expression)
  const scriptHash = createHash("sha256").update(expression).digest("hex")
  let input: ReturnType<typeof captureRequestInput> = {}
  let release: (() => void) | undefined
  if (captures?.available && store.clientRequestIds) {
    try {
      input = captureRequestInput(captures, {
        source: "native",
        operation: "eval",
        parameters: { sessionId, expression },
      })
      if (input.request) {
        release = captures.reserveRequestInput(Buffer.byteLength(input.request))
        if (!release) input = { requestReason: "capture-busy" }
      }
    } catch {
      input = {}
    }
  }
  let success = false
  let cause: SessionActivity["cause"]
  try {
    const value = await run()
    success = true
    return value
  } catch (error) {
    cause = failureCause(error, [{ tier: 3, status: "error", durationMs: 0 }])
    throw error
  } finally {
    try {
      const requestId = pageRequestId?.()
      const retained = store.recordActivity({
        id,
        at,
        sessionId,
        operation: "eval",
        ...(requestId ? { requestId } : {}),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        success,
        ...(cause ? { cause } : {}),
        scriptBytes,
        scriptHash,
      })
      release?.()
      release = undefined
      if (retained && captures?.available && captures.policy.request)
        captures.capture({ requestId: id, requestAt: at, ...input })
    } catch {
      // Recording is optional; preserve eval's result and original exception.
    } finally {
      release?.()
    }
  }
}
