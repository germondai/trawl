import { shutdownPools } from "./deps"

export interface LifecycleOptions {
  onShutdown?: () => Promise<void>
}

function isMalformedBrowserPageError(error: unknown): boolean {
  // Camoufox can omit a page-error location expected by Playwright's dispatcher.
  if (!(error instanceof TypeError)) return false
  const stack = error.stack ?? ""
  if (!/playwright-core[\\/].*(?:browserContextDispatcher|coreBundle)\.js/.test(stack)) return false
  return (
    /evaluating ['"]pageError\.location\.url['"]/.test(error.message) ||
    (/Cannot read properties of (?:undefined|null) \(reading ['"]url['"]\)/.test(error.message) &&
      /browserContextDispatcher/.test(stack))
  )
}

export const registerLifecycleHandlers = (opts: LifecycleOptions = {}): void => {
  let stopping = false
  let exitCode = 0

  const shutdown = async (code = 0) => {
    exitCode = Math.max(exitCode, code)
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => process.exit(exitCode || 1), 30_000)
    try {
      try {
        await opts.onShutdown?.()
      } finally {
        await shutdownPools()
      }
    } catch (error) {
      exitCode = 1
      console.error("[api] shutdown error:", error)
    } finally {
      clearTimeout(deadline)
      process.exit(exitCode)
    }
  }

  const handleFailure = (event: string, error: unknown) => {
    if (isMalformedBrowserPageError(error)) {
      console.error(`[api] ${event} (malformed browser page error):`, error)
      return
    }
    console.error(`[api] ${event}:`, error)
    void shutdown(1)
  }

  process.on("uncaughtException", (error) => handleFailure("uncaughtException", error))
  process.on("unhandledRejection", (error) => handleFailure("unhandledRejection", error))
  process.on("SIGTERM", () => {
    void shutdown()
  })
  process.on("SIGINT", () => {
    void shutdown()
  })
}
