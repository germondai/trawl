import type { Page, Response } from "patchright"

import type { MinimalResponse } from "./response"

type NavigationResponse = MinimalResponse & Pick<Response, "request">

// A redirect loop is capped by the browser long before this, but the chain is caller-
// visible data so it gets a bound of its own.
const MAX_REDIRECT_ENTRIES = Number(process.env.CAPTURE_MAX_REDIRECT_ENTRIES ?? 50)

/** Tracks the latest top-level document response across redirects. */
export class MainDocumentResponseTracker {
  private latest?: NavigationResponse
  private readonly chain: string[] = []

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
    if (this.chain.length >= MAX_REDIRECT_ENTRIES || this.chain.includes(url)) return
    this.chain.push(url)
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

export function trackMainDocumentResponses(
  page: Page,
  options: { redirectChain?: boolean } = {},
): MainDocumentResponseTracker {
  const tracker = new MainDocumentResponseTracker(page, options.redirectChain)
  page.on("response", (response) => tracker.observe(response))
  return tracker
}
