import type { Page, Response } from "patchright"
import { captureLimit } from "./captureConfig"
import type { MinimalResponse } from "./response"

type NavigationResponse = MinimalResponse & Pick<Response, "request">

// A redirect loop is capped by the browser long before this, but the chain is caller-
// visible data so it gets a bound of its own.
const MAX_REDIRECT_ENTRIES = captureLimit(process.env.REDIRECT_MAX_ENTRIES, 50)
const MAX_REDIRECT_URL_CHARS = captureLimit(process.env.REDIRECT_MAX_URL_CHARS, 2_000)
const MAX_REDIRECT_TOTAL_CHARS = captureLimit(process.env.REDIRECT_MAX_TOTAL_CHARS, 1_000_000)

/** Tracks the latest top-level document response across redirects. */
export class MainDocumentResponseTracker {
  private latest?: NavigationResponse
  private readonly chain: string[] = []
  private chainChars = 0

  constructor(
    private readonly page: Pick<Page, "mainFrame">,
    private readonly recordChain = false,
  ) {}

  observe(response: NavigationResponse): void {
    try {
      const request = response.request()
      if (!request.isNavigationRequest() || request.frame() !== this.page.mainFrame()) return
      this.latest = response
      if (this.recordChain) this.record(response.url())
    } catch {
      // A response can disappear while Firefox is replacing a challenge document.
    }
  }

  private record(url: string): void {
    if (
      this.chain.length >= MAX_REDIRECT_ENTRIES ||
      url.length > MAX_REDIRECT_URL_CHARS ||
      this.chainChars + url.length > MAX_REDIRECT_TOTAL_CHARS ||
      this.chain.includes(url)
    )
      return
    this.chain.push(url)
    this.chainChars += url.length
  }

  get response(): MinimalResponse | undefined {
    return this.latest
  }

  get status(): number {
    return this.latest?.status() ?? 200
  }

  get headers(): Record<string, string> {
    return this.latest?.headers() ?? {}
  }

  /** URLs the main document walked, in order. Empty unless chain recording was asked for. */
  get redirectChain(): string[] {
    return [...this.chain]
  }
}

export type MainDocumentResponseTracking = MainDocumentResponseTracker & { dispose(): void }

export function trackMainDocumentResponses(
  page: Page,
  options: { redirectChain?: boolean } = {},
): MainDocumentResponseTracking {
  const tracker = new MainDocumentResponseTracker(page, options.redirectChain)
  const observe = (response: NavigationResponse) => tracker.observe(response)
  page.on("response", observe)
  // Pages retained by a session outlive one request, so the listener must be
  // removable; disposal on a closing page is a harmless no-op.
  return Object.assign(tracker, {
    dispose: () => {
      page.off("response", observe)
    },
  })
}

export const redirectSettings = Object.freeze({
  REDIRECT_MAX_ENTRIES: MAX_REDIRECT_ENTRIES,
  REDIRECT_MAX_URL_CHARS: MAX_REDIRECT_URL_CHARS,
  REDIRECT_MAX_TOTAL_CHARS: MAX_REDIRECT_TOTAL_CHARS,
})
