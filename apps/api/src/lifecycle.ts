import { getPool } from "./deps"

export function registerLifecycleHandlers(): void {
  // Camoufox (Firefox) emits page-error events in a shape playwright-core's dispatcher
  // doesn't expect for some target-page JS errors (e.g. missing `error.location`), which
  // throws inside the library's own internal event handling — outside any try/catch we
  // control, since it fires from a page-level event listener, not from our request path.
  // Without this, one target site's malformed error crashes the entire process and drops
  // every in-flight request across all clients, not just the one that triggered it.
  process.on("uncaughtException", (err) => {
    console.error("[api] uncaughtException (continuing):", err instanceof Error ? err.message : err)
  })

  process.on("unhandledRejection", (reason) => {
    console.error("[api] unhandledRejection (continuing):", reason instanceof Error ? reason.message : reason)
  })

  process.on("SIGTERM", async () => {
    await getPool()?.shutdown()
    process.exit(0)
  })

  process.on("SIGINT", async () => {
    await getPool()?.shutdown()
    process.exit(0)
  })
}
