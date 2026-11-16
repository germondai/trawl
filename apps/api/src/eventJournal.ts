import { randomUUID } from "node:crypto"
import type { JournalEntry } from "@trawl/types"

interface RetainedEvent {
  sequence: number
  json: string
  bytes: number
}

// One retained journal per topic; slow readers share it rather than accumulating private queues.
export class EventJournal<T> {
  private readonly epoch = randomUUID()
  private sequence = 0
  private entries: RetainedEvent[] = []
  private bytes = 0
  private waiters = new Set<() => void>()
  private clients = new Set<() => void>()
  private closed = false

  constructor(
    private readonly limits = {
      entries: 2_048,
      bytes: 2 * 1024 * 1024,
      entryBytes: 16 * 1024,
      clients: 16,
      queueBytes: 64 * 1024,
      heartbeatMs: 20_000,
    },
  ) {}

  get cursor(): string {
    return `${this.epoch}:${this.sequence}`
  }

  get subscribers(): number {
    return this.clients.size
  }

  publish(data: T): boolean {
    if (this.closed) return false
    const json = JSON.stringify(data)
    const bytes = Buffer.byteLength(json) + 128
    if (bytes > this.limits.entryBytes || bytes > this.limits.bytes) {
      this.sequence++
      this.entries = []
      this.bytes = 0
      for (const wake of this.waiters) wake()
      return false
    }
    this.entries.push({ sequence: ++this.sequence, json, bytes })
    this.bytes += bytes
    while (this.entries.length > this.limits.entries || this.bytes > this.limits.bytes) {
      this.bytes -= this.entries.shift()?.bytes ?? 0
    }
    for (const wake of this.waiters) wake()
    return true
  }

  snapshot(limit = 100): { entries: JournalEntry<T>[]; cursor: string } {
    const count = Number.isSafeInteger(limit) ? Math.min(500, Math.max(1, limit)) : 100
    return {
      entries: this.entries.slice(-count).map(({ sequence, json }) => ({
        id: `${this.epoch}:${sequence}`,
        data: JSON.parse(json) as T,
      })),
      cursor: this.cursor,
    }
  }

  close(): void {
    this.closed = true
    for (const close of [...this.clients]) close()
    this.waiters.clear()
    this.entries = []
    this.bytes = 0
  }

  stream(request: Request): Response {
    if (this.closed) return new Response("Stream unavailable", { status: 503 })
    if (this.clients.size >= this.limits.clients)
      return new Response("Too many stream subscribers", { status: 429, headers: { "Retry-After": "5" } })
    const supplied = request.headers.get("last-event-id")
    const match = supplied && /^([a-f0-9-]{36}):(0|[1-9][0-9]{0,15})$/.exec(supplied)
    let seen = match?.[1] === this.epoch ? Number(match[2]) : -1
    let initial = true
    let stopped = false
    let wake: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const id = (sequence: number) => `${this.epoch}:${sequence}`
    const frame = (event: string, data: string, cursor: string) =>
      encoder.encode(`id: ${cursor}\nevent: ${event}\ndata: ${data}\n\n`)
    const cleanup = () => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      if (wake) {
        this.waiters.delete(wake)
        wake()
      }
      this.clients.delete(cleanup)
      request.signal.removeEventListener("abort", cleanup)
      try {
        controller?.close()
      } catch {
        // The reader may already have cancelled.
      }
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (value) => {
          controller = value
          this.clients.add(cleanup)
          request.signal.addEventListener("abort", cleanup, { once: true })
          if (request.signal.aborted) cleanup()
        },
        pull: async (value) => {
          if (stopped) return
          if (initial) {
            initial = false
            if (seen < 0 || seen > this.sequence) {
              seen = this.sequence
              value.enqueue(
                frame(
                  "reset",
                  JSON.stringify({ reason: supplied ? "restart-or-invalid-cursor" : "snapshot-required" }),
                  id(seen),
                ),
              )
              return
            }
            value.enqueue(frame("ready", "{}", id(seen)))
            return
          }
          for (;;) {
            if (stopped) return
            const first = this.entries[0]?.sequence ?? this.sequence + 1
            if (seen < first - 1) {
              seen = this.sequence
              value.enqueue(frame("reset", '{"reason":"replay-expired"}', id(seen)))
              return
            }
            const next = this.entries[seen - first + 1]
            if (next) {
              seen = next.sequence
              value.enqueue(frame("entry", next.json, id(seen)))
              return
            }
            let heartbeat = false
            await new Promise<void>((resolve) => {
              wake = resolve
              this.waiters.add(resolve)
              timer = setTimeout(() => {
                heartbeat = true
                resolve()
              }, this.limits.heartbeatMs)
              timer.unref?.()
            })
            clearTimeout(timer)
            if (wake) this.waiters.delete(wake)
            wake = undefined
            if (heartbeat && !stopped) {
              value.enqueue(encoder.encode(": heartbeat\n\n"))
              return
            }
          }
        },
        cancel: cleanup,
      },
      {
        highWaterMark: Math.max(0, this.limits.queueBytes - this.limits.entryBytes),
        size: (chunk) => chunk?.byteLength ?? 0,
      },
    )
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }
}
