import type { WafDetection } from "@trawl/types"

export interface WafEvidence {
  statusCode?: number
  reasonPhrase?: string
  responseHeaders?: Record<string, string>
  html?: string
  htmlTruncated?: boolean
}

export function wafUnavailable(reason: NonNullable<WafDetection["reason"]>): WafDetection {
  return { engine: "wafmeow", version: "3.1.0", state: "unavailable", products: [], reason }
}

/** Keep only bounded rule references and diagnostic codes, never captured values. */
export function sanitizeWafDetails(
  value: WafDetection,
): Pick<WafDetection, "matches" | "incompleteProducts" | "diagnostics" | "detailsTruncated"> {
  const details: ReturnType<typeof sanitizeWafDetails> = {}
  if (value.matches !== undefined) {
    if (!Array.isArray(value.matches) || value.matches.length > 32) throw new Error("Invalid WAF matches")
    details.matches = value.matches.map((match) => {
      if (
        !match ||
        typeof match.product !== "string" ||
        match.product.length > 256 ||
        !Number.isSafeInteger(match.schema) ||
        match.schema < 1 ||
        !Array.isArray(match.fingerprints) ||
        match.fingerprints.length > 16
      )
        throw new Error("Invalid WAF match")
      return {
        product: match.product,
        schema: match.schema,
        fingerprints: match.fingerprints.map((ref) => {
          if (!ref || !Number.isSafeInteger(ref.fingerprint) || ref.fingerprint < 1 || ref.evidence !== 0)
            throw new Error("Invalid WAF evidence reference")
          return { fingerprint: ref.fingerprint, evidence: ref.evidence }
        }),
      }
    })
  }
  if (value.incompleteProducts !== undefined) {
    if (
      !Array.isArray(value.incompleteProducts) ||
      value.incompleteProducts.length > 256 ||
      !value.incompleteProducts.every((name) => typeof name === "string" && name.length <= 256)
    )
      throw new Error("Invalid incomplete WAF products")
    details.incompleteProducts = [...value.incompleteProducts]
  }
  if (value.diagnostics !== undefined) {
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 16) throw new Error("Invalid WAF diagnostics")
    details.diagnostics = value.diagnostics.map((item) => {
      if (
        !item ||
        !["body_truncated", "missing_response", "invalid_engine", "invalid_evidence", "transport_error"].includes(
          item.code,
        ) ||
        (item.evidence !== 0 && item.evidence !== -1)
      )
        throw new Error("Invalid WAF diagnostic")
      return { code: item.code, evidence: item.evidence }
    })
  }
  if (value.detailsTruncated !== undefined) {
    if (typeof value.detailsTruncated !== "boolean") throw new Error("Invalid WAF detail truncation flag")
    details.detailsTruncated = value.detailsTruncated
  }
  return details
}

export function snapshotWafEvidence(evidence: WafEvidence): string {
  const headers: { name: string; value: string }[] = []
  let headerBytes = 0
  let headersComplete = true
  headerLoop: for (const [name, combined] of Object.entries(evidence.responseHeaders ?? {})) {
    for (const value of name.toLowerCase() === "set-cookie" ? combined.split(/\r?\n/, 129) : [combined]) {
      headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
      if (headerBytes > 16_384 || headers.length >= 128) {
        headersComplete = false
        break headerLoop
      }
      headers.push({ name, value })
    }
  }
  const body = Buffer.from((evidence.html ?? "").slice(0, 65_536)).subarray(0, 65_536)
  const bodyTruncated = Boolean(evidence.htmlTruncated) || body.byteLength < Buffer.byteLength(evidence.html ?? "")
  const reason =
    evidence.reasonPhrase !== undefined && Buffer.byteLength(evidence.reasonPhrase) <= 512
      ? evidence.reasonPhrase
      : undefined
  return JSON.stringify({
    role: "Normal",
    status_code: evidence.statusCode ?? 0,
    reason: reason ?? "",
    headers,
    body: body.toString("base64"),
    body_truncated: bodyTruncated,
    availability: {
      status: evidence.statusCode ? "complete" : "unavailable",
      reason: reason === undefined ? "unavailable" : "complete",
      headers: evidence.responseHeaders ? (headersComplete ? "complete" : "incomplete") : "unavailable",
      body: evidence.html === undefined ? "unavailable" : bodyTruncated ? "incomplete" : "complete",
    },
  })
}

type Worker = ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>
interface Pending {
  worker: Worker
  finish(result: WafDetection): void
}

/** One lazy, offline worker. Diagnostic pressure never queues or holds a browser checkout. */
export class WafDetector {
  private worker?: Worker
  private pending?: Pending
  private idle?: ReturnType<typeof setTimeout>

  constructor(private readonly command = [process.env.WAFMEOW_PATH?.trim() || "/opt/trawl-waf/trawl-waf"]) {}

  async detect(evidence: string, timeoutMs: number, signal?: AbortSignal): Promise<WafDetection> {
    const start = performance.now()
    const result = await this.classify(evidence, timeoutMs, signal)
    return { ...result, durationMs: Math.round((performance.now() - start) * 100) / 100 }
  }

  private async classify(evidence: string, timeoutMs: number, signal?: AbortSignal): Promise<WafDetection> {
    if (signal?.aborted || timeoutMs <= 0) return wafUnavailable("timeout")
    if (this.pending) return wafUnavailable("busy")
    if (this.worker?.killed) return wafUnavailable("busy")
    if (Buffer.byteLength(evidence) > 160 * 1024) return wafUnavailable("failed")
    if (this.idle) clearTimeout(this.idle)
    let worker = this.worker
    if (!worker) {
      try {
        worker = Bun.spawn(this.command, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          env: { PATH: process.env.PATH, GOMAXPROCS: "1", GOMEMLIMIT: "32MiB" },
        })
        this.worker = worker
        void this.read(worker)
        void worker.exited.then(() => {
          if (this.worker === worker) this.worker = undefined
          if (this.pending?.worker === worker) this.pending?.finish(wafUnavailable("failed"))
        })
      } catch {
        return wafUnavailable("not-installed")
      }
    }
    const active = worker
    return new Promise((resolve) => {
      const fail = () => {
        active.kill("SIGKILL")
        this.pending?.finish(wafUnavailable("timeout"))
      }
      const timer = setTimeout(fail, Math.min(timeoutMs, 250))
      const pending: Pending = {
        worker: active,
        finish: (result) => {
          if (this.pending !== pending) return
          this.pending = undefined
          clearTimeout(timer)
          signal?.removeEventListener("abort", fail)
          if (!active.killed) {
            this.idle = setTimeout(() => void this.close(), 60_000)
            this.idle.unref()
          }
          resolve(result)
        },
      }
      this.pending = pending
      signal?.addEventListener("abort", fail, { once: true })
      if (signal?.aborted) return fail()
      try {
        active.stdin.write(`${evidence}\n`)
        Promise.resolve(active.stdin.flush()).catch(() => this.fail(active))
      } catch {
        this.fail(active)
      }
    })
  }

  private fail(worker: Worker): void {
    worker.kill("SIGKILL")
    if (this.pending?.worker === worker) this.pending.finish(wafUnavailable("failed"))
  }

  private async read(worker: Worker): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for await (const chunk of worker.stdout) {
        buffer += decoder.decode(chunk, { stream: true })
        if (buffer.length > 32_768) throw new Error("Oversized detector output")
        let end = buffer.indexOf("\n")
        while (end !== -1) {
          const result = JSON.parse(buffer.slice(0, end)) as WafDetection
          if (
            result.engine !== "wafmeow" ||
            result.version !== "3.1.0" ||
            (result.state !== "complete" && result.state !== "incomplete") ||
            !Array.isArray(result.products) ||
            !result.products.every((name) => typeof name === "string" && name.length <= 256)
          )
            throw new Error("Invalid detector output")
          if (this.pending?.worker !== worker) throw new Error("Unexpected detector output")
          this.pending.finish({
            engine: result.engine,
            version: result.version,
            state: result.state,
            products: result.products,
            ...sanitizeWafDetails(result),
          })
          buffer = buffer.slice(end + 1)
          end = buffer.indexOf("\n")
        }
      }
    } catch {
      this.fail(worker)
    }
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    const worker = this.worker
    if (!worker) return
    worker.kill("SIGKILL")
    if (this.pending?.worker === worker) this.pending.finish(wafUnavailable("failed"))
    await worker.exited
  }
}
