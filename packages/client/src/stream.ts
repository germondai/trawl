import { TrawlError } from "./errors"

export interface StreamOptions {
  signal?: AbortSignal
  cursor?: string
  connectTimeoutMs?: number
  idleTimeoutMs?: number
}

export type StreamEvent<T> =
  | { type: "entry"; id: string; data: T }
  | { type: "ready"; id: string }
  | { type: "reset"; id: string; reason: string }

export const validStreamCursor = (value: string): boolean => /^[a-f0-9-]{36}:(0|[1-9][0-9]{0,15})$/.test(value)

export async function* parseEvents<T>(
  read: () => Promise<{ done: boolean; value?: Uint8Array }>,
  valid: (value: unknown) => value is T,
): AsyncGenerator<StreamEvent<T>> {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  let buffer = ""
  let frameBytes = 0
  let event = ""
  let cursor = ""
  let data: string[] = []
  for (;;) {
    const next = await read()
    if (next.done) return
    if (!next.value) continue
    for (let offset = 0; offset < next.value.byteLength; offset += 4096) {
      try {
        buffer += decoder.decode(next.value.subarray(offset, offset + 4096), { stream: true })
      } catch {
        throw new TrawlError("Invalid stream encoding", { kind: "protocol" })
      }
      let position = buffer.indexOf("\n")
      while (position !== -1) {
        const line = buffer.slice(0, position).replace(/\r$/, "")
        buffer = buffer.slice(position + 1)
        frameBytes += encoder.encode(line).byteLength + 1
        if (frameBytes > 16 * 1024) throw new TrawlError("Stream event exceeds its budget", { kind: "protocol" })
        if (line === "") {
          if (event && data.length) {
            if (!validStreamCursor(cursor)) throw new TrawlError("Invalid stream cursor", { kind: "protocol" })
            let value: unknown
            try {
              value = JSON.parse(data.join("\n"))
            } catch {
              throw new TrawlError("Invalid stream JSON", { kind: "protocol" })
            }
            if (event === "entry") {
              if (!valid(value)) throw new TrawlError("Unexpected stream entry", { kind: "protocol" })
              yield { type: "entry", id: cursor, data: value }
            } else if (event === "ready") yield { type: "ready", id: cursor }
            else if (
              event === "reset" &&
              value &&
              typeof value === "object" &&
              "reason" in value &&
              typeof value.reason === "string"
            )
              yield { type: "reset", id: cursor, reason: value.reason.slice(0, 128) }
            else throw new TrawlError("Unexpected stream event", { kind: "protocol" })
          }
          event = ""
          cursor = ""
          data = []
          frameBytes = 0
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":")
          const field = colon < 0 ? line : line.slice(0, colon)
          const content = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
          if (field === "event") event = content
          if (field === "id") cursor = content
          if (field === "data") data.push(content)
        }
        position = buffer.indexOf("\n")
      }
      if (encoder.encode(buffer).byteLength + frameBytes > 16 * 1024)
        throw new TrawlError("Stream event exceeds its budget", { kind: "protocol" })
    }
  }
}
