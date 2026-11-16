import { $fetch } from "ofetch"
import { TrawlError } from "./errors"
import { isRecord } from "./responses"
import { parseEvents, type StreamEvent, type StreamOptions, validStreamCursor } from "./stream"
import type { RequestOptions, TrawlOptions } from "./types"

function baseURL(input = "http://localhost:8191"): string {
  const relative = input.startsWith("/") && !input.startsWith("//")
  const url = new URL(input, relative ? "http://trawl.invalid" : undefined)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new TypeError("baseURL must be an HTTP(S) URL without credentials, query or fragment")
  if (input.startsWith("//")) throw new TypeError("baseURL must not be a protocol-relative URL")
  return (relative ? url.pathname : url.href).replace(/\/+$/, "")
}

function checkTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 2_147_483_647))
    throw new TypeError("timeoutMs must be an integer from 1 to 2147483647")
}

interface TransportRequest extends RequestOptions {
  method?: "GET" | "POST" | "DELETE"
  body?: object
}

export class Transport {
  #http: ReturnType<typeof $fetch.create>
  #timeoutMs: number | undefined

  constructor(options: TrawlOptions) {
    checkTimeout(options.timeoutMs)
    const headers = new Headers(options.headers)
    if (options.apiKey !== undefined) {
      if (!options.apiKey.trim()) throw new TypeError("apiKey must not be empty")
      headers.set("authorization", `Bearer ${options.apiKey.trim()}`)
    }
    this.#timeoutMs = options.timeoutMs
    this.#http = $fetch.create(
      { baseURL: baseURL(options.baseURL), headers, retry: 0, redirect: "manual", ignoreResponseError: true },
      { fetch: (options.fetch ?? globalThis.fetch) as typeof globalThis.fetch },
    )
  }

  async request<T>(path: string, options: TransportRequest, valid: (value: unknown) => value is T): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    checkTimeout(timeoutMs)
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const timer = timeoutMs
      ? setTimeout(() => {
          if (!controller.signal.aborted) {
            timedOut = true
            controller.abort()
          }
        }, timeoutMs)
      : undefined
    try {
      if (controller.signal.aborted) throw new TrawlError("TRAWL request aborted", { kind: "aborted" })
      const response = await this.#http.raw<unknown>(path, {
        method: options.method ?? "GET",
        body: options.body,
        responseType: "json",
        signal: controller.signal,
      })
      if (controller.signal.aborted) throw new Error("Request cancelled")
      const data = response._data
      const id = response.headers.get("x-trawl-request-id")
      if (response.status < 200 || response.status >= 300) {
        const message = isRecord(data)
          ? typeof data.error === "string"
            ? data.error
            : typeof data.message === "string"
              ? data.message
              : undefined
          : undefined
        throw new TrawlError(message || `TRAWL API returned HTTP ${response.status}`, {
          kind: "api",
          status: response.status,
          data,
          retryAfter: response.headers.get("retry-after") ?? undefined,
          ...(id && /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? { requestId: id } : {}),
        })
      }
      if (!valid(data))
        throw new TrawlError("Unexpected TRAWL API response", { kind: "protocol", status: response.status, data })
      return data
    } catch (error) {
      if (error instanceof TrawlError) throw error
      if (controller.signal.aborted)
        throw new TrawlError(timedOut ? "TRAWL request timed out" : "TRAWL request aborted", {
          kind: timedOut ? "timeout" : "aborted",
        })
      throw new TrawlError("Could not reach the TRAWL API", { kind: "network" })
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
    }
  }

  async bytes(path: string, options: RequestOptions = {}, maximum: number = 8 * 1024 * 1024): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs ?? 15000
    checkTimeout(timeoutMs)
    const controller = new AbortController()
    let timedOut = false
    let completed = false
    const abort = () => controller.abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        timedOut = true
        controller.abort()
      }
    }, timeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      let cancel = () => {}
      const stopped = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("Artifact read stopped"))
        controller.signal.addEventListener("abort", cancel, { once: true })
        if (controller.signal.aborted) cancel()
      })
      try {
        return await Promise.race([operation, stopped])
      } finally {
        controller.signal.removeEventListener("abort", cancel)
      }
    }
    try {
      if (controller.signal.aborted) throw new Error("Aborted")
      const response = await wait(
        this.#http.raw<ReadableStream<Uint8Array>, "stream">(path, {
          method: "GET",
          responseType: "stream",
          signal: controller.signal,
        }),
      )
      reader = response._data?.getReader()
      if (response.status < 200 || response.status >= 300)
        throw new TrawlError(`Artifact API returned HTTP ${response.status}`, { kind: "api", status: response.status })
      if (!reader) throw new TrawlError("Artifact API returned no body", { kind: "protocol" })
      if (Number(response.headers.get("content-length")) > maximum)
        throw new TrawlError(`Artifact exceeds the ${maximum / 1048576} MiB client limit`, { kind: "protocol" })
      let buffer = new Uint8Array(0)
      let used = 0
      let chunks = 0
      while (true) {
        const chunk = await wait(reader.read())
        if (chunk.done) break
        if (!(chunk.value instanceof Uint8Array))
          throw new TrawlError("Invalid artifact byte stream", { kind: "protocol" })
        // Eager providers must yield so deadlines and caller cancellation can run.
        if (++chunks % 256 === 0) await wait(new Promise<void>((resolve) => setTimeout(resolve, 0)))
        const size = used + chunk.value.byteLength
        if (size > maximum)
          throw new TrawlError(`Artifact exceeds the ${maximum / 1048576} MiB client limit`, { kind: "protocol" })
        if (size > buffer.byteLength) {
          const grown = new Uint8Array(Math.min(maximum, Math.max(65536, size, buffer.byteLength * 2)))
          grown.set(buffer.subarray(0, used))
          buffer = grown
        }
        buffer.set(chunk.value, used)
        used = size
      }
      const bytes = buffer.slice(0, used)
      completed = true
      return bytes
    } catch (error) {
      if (controller.signal.aborted)
        throw new TrawlError(timedOut ? "Artifact read timed out" : "Artifact read aborted", {
          kind: timedOut ? "timeout" : "aborted",
        })
      if (error instanceof TrawlError) throw error
      throw new TrawlError("Could not read the saved artifact", { kind: "network" })
    } finally {
      clearTimeout(timer)
      if (!completed) controller.abort()
      options.signal?.removeEventListener("abort", abort)
      if (!completed) void reader?.cancel().catch(() => {})
    }
  }

  async *events<T>(
    path: string,
    options: StreamOptions,
    valid: (value: unknown) => value is T,
  ): AsyncGenerator<StreamEvent<T>> {
    if (options.cursor !== undefined && !validStreamCursor(options.cursor)) throw new TypeError("Invalid stream cursor")
    const connectMs = options.connectTimeoutMs ?? this.#timeoutMs ?? 15_000
    const idleMs = options.idleTimeoutMs ?? 35_000
    checkTimeout(connectMs)
    checkTimeout(idleMs)
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    let timedOut = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, ms)
    }
    const wait = async <R>(operation: Promise<R>): Promise<R> => {
      let rejectAbort: () => void = () => {}
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error("Stream aborted"))
        controller.signal.addEventListener("abort", rejectAbort, { once: true })
        if (controller.signal.aborted) rejectAbort()
      })
      try {
        return await Promise.race([operation, cancelled])
      } finally {
        controller.signal.removeEventListener("abort", rejectAbort)
      }
    }
    try {
      if (controller.signal.aborted) throw new Error("Aborted")
      deadline(connectMs)
      const response = await wait(
        this.#http.raw<unknown, "stream">(path, {
          responseType: "stream",
          method: "GET",
          signal: controller.signal,
          headers: options.cursor ? { "Last-Event-ID": options.cursor } : {},
        }),
      )
      clearTimeout(timer)
      if (response._data?.getReader) reader = response._data.getReader()
      if (!response.ok)
        throw new TrawlError(`TRAWL stream returned HTTP ${response.status}`, {
          kind: "api",
          status: response.status,
          retryAfter: response.headers.get("retry-after") ?? undefined,
        })
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !reader)
        throw new TrawlError("Expected an event stream", { kind: "protocol" })
      const source = reader
      const read = async () => {
        if (controller.signal.aborted) throw new Error("Aborted")
        deadline(idleMs)
        try {
          return await wait(source.read())
        } finally {
          clearTimeout(timer)
        }
      }
      for await (const entry of parseEvents(read, valid)) {
        if (controller.signal.aborted) throw new Error("Aborted")
        yield entry
      }
      throw new TrawlError("TRAWL event stream closed", { kind: "network" })
    } catch (error) {
      if (controller.signal.aborted)
        throw new TrawlError(timedOut ? "TRAWL stream timed out" : "TRAWL stream aborted", {
          kind: timedOut ? "timeout" : "aborted",
        })
      if (error instanceof TrawlError) throw error
      throw new TrawlError("Could not read the TRAWL stream", { kind: "network" })
    } finally {
      clearTimeout(timer)
      controller.abort()
      options.signal?.removeEventListener("abort", abort)
      await reader?.cancel().catch(() => {})
    }
  }
}
