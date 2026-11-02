import type {
  BrowserSession,
  Cookie,
  CreateBrowserSession,
  ScrapeResponse,
  SessionCloseResponse,
  SessionCookiesResponse,
  SessionEvalResponse,
  SessionListResponse,
} from "../../types/src/api"
import { prepareScrapeRequest } from "./request"
import { isCookie, isRecord, isScrapeResponse, isSession } from "./responses"
import type { Transport } from "./transport"
import type { EvalOptions, RequestOptions, ScrapeRequest } from "./types"

function sessionPath(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError("Invalid session ID")
  return `/sessions/${encodeURIComponent(id)}`
}

export class Sessions {
  #transport: Transport

  constructor(transport: Transport) {
    this.#transport = transport
  }

  async create(options: CreateBrowserSession = {}, request: RequestOptions = {}): Promise<TrawlSession> {
    const details = await this.#transport.request("/sessions", { ...request, method: "POST", body: options }, isSession)
    return new TrawlSession(details, this)
  }

  async list(options: RequestOptions = {}): Promise<BrowserSession[]> {
    const response = await this.#transport.request(
      "/sessions",
      options,
      (value): value is SessionListResponse =>
        isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isSession),
    )
    return response.sessions
  }

  async scrape(id: string, options: ScrapeRequest, request: RequestOptions = {}): Promise<ScrapeResponse> {
    if (options.sessionId !== undefined && options.sessionId !== id)
      throw new TypeError("sessionId must match the session ID in the URL")
    return this.#transport.request(
      `${sessionPath(id)}/scrape`,
      { ...request, method: "POST", body: prepareScrapeRequest(options) },
      isScrapeResponse,
    )
  }

  async eval(id: string, expression: string, options: EvalOptions = {}): Promise<unknown> {
    const response = await this.#transport.request(
      `${sessionPath(id)}/eval`,
      { ...options, method: "POST", body: { expression, maxTimeout: options.maxTimeout } },
      (value): value is SessionEvalResponse => isRecord(value) && Object.hasOwn(value, "value"),
    )
    return response.value
  }

  async cookies(id: string, options: RequestOptions = {}): Promise<Cookie[]> {
    const response = await this.#transport.request(
      `${sessionPath(id)}/cookies`,
      options,
      (value): value is SessionCookiesResponse =>
        isRecord(value) && Array.isArray(value.cookies) && value.cookies.every(isCookie),
    )
    return response.cookies
  }

  async destroy(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#transport.request(
      sessionPath(id),
      { ...options, method: "DELETE" },
      (value): value is SessionCloseResponse => isRecord(value) && value.status === "ok",
    )
  }
}

export class TrawlSession {
  readonly id: string
  readonly details: Readonly<BrowserSession>
  #sessions: Sessions

  constructor(details: BrowserSession, sessions: Sessions) {
    this.id = details.id
    this.details = Object.freeze({ ...details })
    this.#sessions = sessions
  }

  scrape(options: ScrapeRequest, request?: RequestOptions): Promise<ScrapeResponse> {
    return this.#sessions.scrape(this.id, options, request)
  }

  eval(expression: string, options?: EvalOptions): Promise<unknown> {
    return this.#sessions.eval(this.id, expression, options)
  }

  cookies(options?: RequestOptions): Promise<Cookie[]> {
    return this.#sessions.cookies(this.id, options)
  }

  close(options?: RequestOptions): Promise<void> {
    return this.#sessions.destroy(this.id, options)
  }
}
