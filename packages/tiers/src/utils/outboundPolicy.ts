export type OutboundUrlValidator = (url: string) => Promise<void>

interface BrowserRoute {
  abort(errorCode?: string): Promise<void>
  fallback(): Promise<void>
  request(): { url(): string }
}

interface RoutablePage {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<unknown>
}

export async function installOutboundPolicy(page: RoutablePage, validate?: OutboundUrlValidator): Promise<void> {
  if (!validate) return
  await page.route("**/*", async (route) => {
    try {
      await validate(route.request().url())
      await route.fallback()
    } catch {
      await route.abort("blockedbyclient")
    }
  })
}
