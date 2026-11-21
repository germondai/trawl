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
import type { RequestCaptures } from "../../types/src/artifacts"
import type { SessionActivity, SessionActivityPage } from "../../types/src/observability"
import { isCaptures, isSessionActivity } from "./observability"
import { prepareScrapeRequest } from "./request"
import { isCookie, isRecord, isScrapeResponse, isSession } from "./responses"
import type { Transport } from "./transport"
import type { EvalOptions, RequestOptions, ScrapeRequest } from "./types"

function sessionPath(id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError("Invalid session ID")
  return `/sessions/${encodeURIComponent(id)}`
}

function activityPath(id: string | undefined, requestId: string | undefined, limit: number, page?: number) {
  if (id !== undefined) sessionPath(id)
  if (requestId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new TypeError("Invalid request ID")
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Invalid activity limit")
  if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 5000))
    throw new TypeError("Invalid activity page")
  return `/session-activity?limit=${limit}${id ? `&sessionId=${encodeURIComponent(id)}` : ""}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ""}${page === undefined ? "" : `&page=${page}`}`
}

export class Sessions {
  #transport: Transport

  constructor(transport: Transport) {
    this.#transport = transport
  }

  async activity(id?: string, options: RequestOptions & { requestId?: string } = {}): Promise<SessionActivity[]> {
    const { requestId, ...request } = options
    const response = await this.#transport.request(
      activityPath(id, requestId, 50),
      request,
      (value): value is { entries: SessionActivity[] } =>
        isRecord(value) &&
        Array.isArray(value.entries) &&
        value.entries.length <= 100 &&
        value.entries.every(isSessionActivity),
    )
    return response.entries
  }
  activityPage(
    id?: string,
    options: RequestOptions & { requestId?: string; page?: number; limit?: number } = {},
  ): Promise<SessionActivityPage> {
    const { requestId, page = 1, limit = 20, ...request } = options
    return this.#transport.request(
      activityPath(id, requestId, limit, page),
      request,
      (value): value is SessionActivityPage =>
        isRecord(value) &&
        Number.isInteger(value.total) &&
        Number(value.total) >= 0 &&
        Number(value.total) <= 5000 &&
        Number.isInteger(value.page) &&
        Number(value.page) >= 1 &&
        Number(value.page) <= 5000 &&
        Array.isArray(value.entries) &&
        value.entries.length <= limit &&
        value.entries.every(isSessionActivity),
    )
  }
  activityCaptures(id: string, options: RequestOptions = {}): Promise<RequestCaptures> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new TypeError("Invalid activity ID")
    return this.#transport.request(
      `/session-activity/${id}/captures`,
      options,
      (value): value is RequestCaptures => isCaptures(value) && value.requestId === id,
    )
  }
  activityScript(id: string, options: RequestOptions = {}): Promise<Uint8Array> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new TypeError("Invalid activity ID")
    return this.#transport.bytes(`/session-activity/${id}/captures/request`, options)
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
