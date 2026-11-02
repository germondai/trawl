import type {
  ExtractResponse,
  HealthResponse,
  ReadResponse,
  ScrapeResponse,
  ServerInfoResponse,
  StatsResponse,
} from "../../types/src/api"
import { TrawlError } from "./errors"
import { prepareScrapeRequest } from "./request"
import { isExtractResponse, isHealth, isReadResponse, isScrapeResponse, isServerInfo, isStats } from "./responses"
import { Sessions } from "./sessions"
import { Transport } from "./transport"
import type {
  ExtractRequest,
  InspectRequest,
  InspectResponse,
  ReadRequest,
  RequestOptions,
  ScrapeRequest,
  ScreenshotRequest,
  ScreenshotResponse,
  TrawlOptions,
} from "./types"

export class Trawl {
  readonly sessions: Sessions
  #transport: Transport

  constructor(options: TrawlOptions = {}) {
    this.#transport = new Transport(options)
    this.sessions = new Sessions(this.#transport)
  }

  async scrape(options: ScrapeRequest, request: RequestOptions = {}): Promise<ScrapeResponse> {
    return this.#transport.request(
      "/scrape",
      { ...request, method: "POST", body: prepareScrapeRequest(options) },
      isScrapeResponse,
    )
  }

  async read(options: ReadRequest, request: RequestOptions = {}): Promise<ReadResponse> {
    return this.#transport.request(
      "/read",
      { ...request, method: "POST", body: prepareScrapeRequest(options) },
      isReadResponse,
    )
  }

  async extract(options: ExtractRequest, request: RequestOptions = {}): Promise<ExtractResponse> {
    return this.#transport.request(
      "/extract",
      { ...request, method: "POST", body: prepareScrapeRequest(options) },
      isExtractResponse,
    )
  }

  async screenshot(options: ScreenshotRequest, request: RequestOptions = {}): Promise<ScreenshotResponse> {
    requireBrowser(options)
    const result = await this.scrape({ ...options, skipHttp: true, screenshot: true }, request)
    if (typeof result.screenshot !== "string" || !result.screenshot)
      throw new TrawlError("TRAWL did not return a screenshot", { kind: "protocol", data: { timings: result.timings } })
    return { ...result, screenshot: result.screenshot }
  }

  async inspect(options: InspectRequest, request: RequestOptions = {}): Promise<InspectResponse> {
    requireBrowser(options)
    const result = await this.scrape(
      { ...options, skipHttp: true, consoleLogs: true, networkLogs: true, redirectChain: true },
      request,
    )
    for (const field of ["consoleLogs", "networkLogs", "redirectChain"] as const)
      if (result[field] !== undefined && !Array.isArray(result[field]))
        throw new TrawlError("TRAWL returned invalid browser diagnostics", { kind: "protocol" })
    return {
      ...result,
      consoleLogs: result.consoleLogs ?? [],
      networkLogs: result.networkLogs ?? [],
      redirectChain: result.redirectChain ?? [],
    }
  }

  info(options: RequestOptions = {}): Promise<ServerInfoResponse> {
    return this.#transport.request("/", options, isServerInfo)
  }

  health(options: RequestOptions = {}): Promise<HealthResponse> {
    return this.#transport.request("/health", options, isHealth)
  }

  stats(options: RequestOptions = {}): Promise<StatsResponse> {
    return this.#transport.request("/stats", options, isStats)
  }
}

function requireBrowser(options: { maxTier?: number }): void {
  if (options.maxTier === 1) throw new TypeError("Browser helpers require maxTier 2 or higher")
}
