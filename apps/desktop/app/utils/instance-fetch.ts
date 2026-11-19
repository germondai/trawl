import { Channel, invoke } from "@tauri-apps/api/core"
import { type Fetch, TrawlError } from "@trawl/client"

interface StreamMessage {
  type: "registered" | "open" | "data"
  status?: number
  sequence?: number
  frame?: string
}

export type ObserveRequestId = (id: string, proposed: boolean) => void
export function createInstanceFetch(instanceId: string, baseURL: string, observeId?: ObserveRequestId): Fetch {
  const base = new URL(baseURL)
  const prefix = base.pathname.replace(/\/+$/, "")
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`))
      throw new Error("Unsupported desktop API request")
    const path = url.pathname.slice(prefix.length) + url.search
    if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError")
    if (request.method === "POST" && ["/scrape", "/read", "/extract"].includes(path))
      return operation(instanceId, path, request, observeId)
    if (
      (request.method === "POST" && path === "/sessions") ||
      (request.method === "DELETE" && /^\/sessions\/[A-Za-z0-9_-]{1,128}$/.test(path))
    )
      return operation(instanceId, path, request)
    if (request.method !== "GET") throw new Error("Unsupported desktop API request")
    if (path === "/browser/pages") return operation(instanceId, path, request)
    if (
      /^\/requests\/[A-Za-z0-9_-]{1,80}\/captures\/(html|screenshot|request)$/.test(path) ||
      /^\/browser\/pages\/[A-Za-z0-9_-]{1,80}\/preview$/.test(path)
    )
      return operation(instanceId, path, request)
    if (["/requests/events", "/logs/events"].includes(path))
      return stream(instanceId, path === "/requests/events" ? "requests" : "logs", request)
    const result = await invoke<{ status: number; body: string }>("api_request", { instanceId, path })
    if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError")
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } })
  }
}

async function operation(
  instanceId: string,
  path: string,
  request: Request,
  observeId?: ObserveRequestId,
): Promise<Response> {
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > 1024 * 1024)
    throw new TrawlError("Request exceeds the 1 MiB desktop input limit", { kind: "protocol" })
  if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError")
  const operationId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let stopped = false
    let status: number | undefined
    let requestId: string | undefined
    let contentType = "application/json"
    const cancel = () => invoke("api_operation_cancel", { operationId }).catch(() => {})
    const abort = () => {
      stopped = true
      void cancel()
      reject(new DOMException("Stopped waiting for the request", "AbortError"))
    }
    const channel = new Channel<{
      type: "registered" | "open"
      status?: number
      requestId?: string
      contentType?: string
    }>()
    channel.onmessage = (value) => {
      if (stopped) {
        void cancel()
        return
      }
      if (value.type === "open") {
        status = value.status
        requestId = value.requestId
        if (
          value.contentType &&
          ["application/json", "text/plain; charset=utf-8", "image/jpeg"].includes(value.contentType)
        )
          contentType = value.contentType
      }
      if (value.requestId && /^[A-Za-z0-9_-]{1,80}$/.test(value.requestId))
        observeId?.(value.requestId, value.type === "registered")
    }
    request.signal.addEventListener("abort", abort, { once: true })
    void invoke<ArrayBuffer | number[]>("api_operation", {
      instanceId,
      path,
      method: request.method,
      body,
      operationId,
      onEvent: channel,
    })
      .then((bytes) => {
        if (stopped) return
        if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599)
          throw new Error("Invalid instance response status")
        const headers = new Headers({ "content-type": contentType })
        if (requestId && /^[A-Za-z0-9_-]{1,80}$/.test(requestId)) headers.set("x-trawl-request-id", requestId)
        resolve(new Response(bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes), { status, headers }))
      })
      .catch((cause: unknown) => {
        if (!stopped)
          reject(new TrawlError(cause instanceof Error ? cause.message : String(cause), { kind: "network", requestId }))
      })
      .finally(() => request.signal.removeEventListener("abort", abort))
    if (request.signal.aborted) abort()
  })
}

function stream(instanceId: string, topic: string, request: Request): Promise<Response> {
  const streamId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let stopped = false
    let opened = false
    let waiting = false
    let pendingAck: number | undefined
    let controller: ReadableStreamDefaultController<Uint8Array>
    const cancel = () => invoke<void>("api_stream_cancel", { streamId }).catch(() => {})
    const cleanup = () => request.signal.removeEventListener("abort", abort)
    const fail = (cause: unknown) => {
      if (stopped) return
      stopped = true
      cleanup()
      void cancel()
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (!opened) reject(error)
      try {
        controller.error(error)
      } catch {
        /* Already cancelled. */
      }
    }
    const abort = () => fail(new DOMException("Request aborted", "AbortError"))
    const ack = (sequence: number) => {
      void invoke("api_stream_ack", { streamId, sequence }).catch(fail)
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
        },
        pull() {
          waiting = true
          if (pendingAck !== undefined) {
            ack(pendingAck)
            pendingAck = undefined
          }
        },
        cancel() {
          if (stopped) return
          stopped = true
          cleanup()
          return cancel()
        },
      },
      { highWaterMark: 0 },
    )
    const channel = new Channel<StreamMessage>()
    channel.onmessage = (message) => {
      if (stopped) {
        void cancel()
        return
      }
      if (message.type === "open") {
        if (
          opened ||
          typeof message.status !== "number" ||
          !Number.isInteger(message.status) ||
          message.status < 200 ||
          message.status > 599
        ) {
          fail(new Error("Invalid stream response"))
          return
        }
        opened = true
        resolve(
          new Response(message.status === 200 ? body : null, {
            status: message.status,
            headers: { "content-type": "text/event-stream" },
          }),
        )
        if (message.status !== 200) {
          stopped = true
          cleanup()
          controller.close()
          void cancel()
        }
      } else if (message.type === "data") {
        if (
          !opened ||
          typeof message.frame !== "string" ||
          message.frame.length > 16 * 1024 ||
          typeof message.sequence !== "number" ||
          !Number.isSafeInteger(message.sequence)
        ) {
          fail(new Error("Invalid stream frame"))
          return
        }
        controller.enqueue(new TextEncoder().encode(message.frame))
        if (waiting) {
          waiting = false
          ack(message.sequence)
        } else pendingAck = message.sequence
      }
    }
    request.signal.addEventListener("abort", abort, { once: true })
    if (request.signal.aborted) {
      abort()
      return
    }
    void invoke("api_stream", {
      instanceId,
      topic,
      streamId,
      cursor: request.headers.get("last-event-id"),
      onEvent: channel,
    })
      .then(() => {
        if (!stopped) fail(new Error("Event stream closed"))
      })
      .catch(fail)
  })
}
