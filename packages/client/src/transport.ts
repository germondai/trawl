import { $fetch } from "ofetch"
import { TrawlError } from "./errors"
import { isRecord } from "./responses"
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
}
