import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { version } from "../../../package.json"
import { manage } from "./management"
import { runtimePaths } from "./paths"
import { manageService } from "./services"

const help = `TRAWL native server (unreleased)

Usage: trawl-server [serve] [--home <directory>] [server options]
       trawl-server setup [--home <directory>]
       trawl-server profile balanced|economy [--home <directory>]
       trawl-server config [--home <directory>]
       trawl-server service install|uninstall [--home <directory>]
       trawl-server doctor [--home <directory>]

setup downloads and verifies the browser; npm and external Bun are not required.
serve runs in the foreground. service installs an opt-in, visible user login job.
Options mirror environment settings, e.g. --port 8195 --browser-pool-size 1.
Use the separate trawl CLI or SDK for API requests and remote instances.
`
export async function nativeCommand(args: string[]): Promise<boolean> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help)
    return true
  }
  if (args.includes("--version")) {
    console.log(`${version} (native preview)`)
    return true
  }
  if (!["setup", "profile", "config", "service", "doctor"].includes(args[0])) return false
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { home: { type: "string" } },
  })
  const [command, argument, ...extra] = positionals
  if (extra.length || (argument && !["service", "profile"].includes(command)))
    throw new Error("Unexpected command argument")
  const paths = runtimePaths(values.home)
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error("Operation cancelled"))
  process.on("SIGINT", cancel)
  process.on("SIGTERM", cancel)
  const end = () => cancel()
  if (process.env.TRAWL_PARENT_WATCH === "1") {
    process.stdin.once("end", end)
    process.stdin.resume()
  }
  try {
    let result: unknown
    if (command === "service") {
      if (argument !== "install" && argument !== "uninstall")
        throw new Error("Service command must be install or uninstall")
      const resources = process.env.TRAWL_RUNTIME_RESOURCES || dirname(process.execPath)
      process.env.TRAWL_RUNTIME_EXECUTABLE = join(
        resources,
        process.platform === "win32" ? "trawl-server.exe" : "trawl-server",
      )
      result = await manageService(argument, paths)
    } else {
      if (command === "profile" && argument !== "balanced" && argument !== "economy")
        throw new Error("Profile must be balanced or economy")
      result = await manage(
        {
          action: command === "setup" ? "installBrowser" : command,
          home: paths.home,
          ...(command === "profile" ? { profile: argument as "balanced" | "economy" } : {}),
        },
        controller.signal,
      )
    }
    console.log(JSON.stringify(result, null, 2))
    return true
  } catch (error) {
    if (!controller.signal.aborted) throw error
    console.error("Operation cancelled")
    process.exitCode = 130
    return true
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
    process.stdin.removeListener("end", end)
    if (process.env.TRAWL_PARENT_WATCH === "1") process.stdin.destroy()
  }
}
