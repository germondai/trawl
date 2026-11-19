import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

// Dispatch before importing API configuration; a PoW worker must never boot a server.
if (process.argv.includes("--internal-pow-worker")) {
  await import(
    pathToFileURL(join(process.env.TRAWL_RUNTIME_RESOURCES || dirname(process.execPath), "pow-worker.mjs")).href
  )
} else if (process.argv.includes("--manage")) {
  const { manage } = await import("./management")
  const watching = process.argv.includes("--watch-parent")
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error("Operation cancelled"))
  process.on("SIGINT", cancel)
  process.on("SIGTERM", cancel)
  process.stdout.on("error", () => {})
  try {
    const { readText, readParentRequest } = await import("./input")
    const input = watching ? await readParentRequest(process.stdin, controller) : await readText(process.stdin)
    const { installationProgress } = await import("./progress")
    const progress = process.argv.includes("--progress")
      ? installationProgress((value) => {
          process.stderr.write(`${JSON.stringify(value)}\n`)
        })
      : undefined
    const result = await manage(JSON.parse(input), controller.signal, progress)
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Management request failed" })}\n`,
    )
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
    if (watching) process.stdin.destroy()
  }
} else {
  const { runServer } = await import("./serve")
  try {
    const { nativeCommand } = await import("./commands")
    if (!(await nativeCommand(process.argv.slice(2)))) await runServer(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Server startup failed")
    process.exitCode = 1
  }
}
