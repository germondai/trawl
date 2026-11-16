import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import {
  type ExtractRequest,
  type InspectRequest,
  type ReadRequest,
  type ScrapeRequest,
  type ScreenshotRequest,
  Trawl,
  TrawlError,
} from "@trawl/client"
import {
  exportEnvFile,
  flagEnvironment,
  parseEnvFile,
  profiles,
  redactEnvironment,
  settingFlags,
  validateEnvironment,
} from "@trawl/config"
import {
  browserStatus,
  control,
  installBrowser,
  installRuntime,
  publicConfig,
  readConfig,
  readTextFile,
  resolveManagedEnvironment,
  runtimeExecutable,
  runtimePaths,
  startManaged,
  stopManaged,
  tailLog,
  uninstallBrowser,
  writeConfig,
} from "@trawl/runtime"

export interface CliIO {
  out: (value: string) => void
  err: (value: string) => void
  input: () => Promise<string>
  signal?: AbortSignal
}
export const help = `TRAWL

Usage: trawl <command> [arguments] [options]

API:       scrape, read, extract, screenshot, inspect <url>
           info, health, stats, metrics [--minutes 60]
           sessions list|create|scrape|eval|cookies|destroy [id] [url]
Local:     serve
           server start|stop|restart|status|logs
           browser install|status|repair|uninstall
           runtime install --from <verified-bundle-directory>
           config show|set|validate|import|export|profile [name] [value]
           service install|uninstall
           doctor

Options:   --base-url <url>      Existing TRAWL API (default: local instance)
           --home <directory>   Local configuration and runtime directory
           --options <file|->   Native request JSON; '-' reads stdin
           --output <path>      Save result; screenshots are decoded to JPEG
           --timeout <ms>       Client deadline
           --format <format>    JSON (default), html, markdown or text
           --help, --version

API credentials: TRAWL_API_KEY. No browser is downloaded by npm installation.
Server environment flags use kebab-case: --browser-pool-size 2.
`
function number(value: string | boolean | undefined, name: string) {
  if (value === undefined) return
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2147483647)
    throw new Error(`${name} must be a positive integer`)
  return parsed
}
async function requestOptions(path: string | boolean | undefined, io: CliIO): Promise<Record<string, unknown>> {
  if (!path) return {}
  if (typeof path !== "string") throw new Error("--options requires a file or -")
  const raw = path === "-" ? await io.input() : await readTextFile(path)
  if (raw.length > 1048576) throw new Error("Request options exceed 1 MiB")
  const value = JSON.parse(raw)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request options must be an object")
  return value
}
export async function runCli(args: string[], io: CliIO): Promise<number> {
  try {
    const dynamic = settingFlags()
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        ...dynamic,
        "base-url": { type: "string" },
        home: { type: "string" },
        options: { type: "string" },
        output: { type: "string" },
        format: { type: "string" },
        timeout: { type: "string" },
        minutes: { type: "string" },
        from: { type: "string" },
        "include-secrets": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    })
    if (values.version) {
      io.out("0.1.0 (unreleased)\n")
      return 0
    }
    if (values.help || positionals.length === 0) {
      io.out(help)
      return 0
    }
    if (values.format && !["json", "html", "text", "markdown"].includes(String(values.format)))
      throw new Error("Unsupported output format")
    const [command, action, ...rest] = positionals
    const paths = runtimePaths(values.home as string | undefined)
    const config = await readConfig(paths)
    const flags = flagEnvironment(values)
    let result: unknown
    if (command === "config") {
      if (action === "show")
        result = {
          ...publicConfig(config),
          effective: redactEnvironment(resolveManagedEnvironment(paths, config.env, process.env, flags).values),
          sources: resolveManagedEnvironment(paths, config.env, process.env, flags).sources,
        }
      else if (action === "set") {
        if (rest.length !== 2) throw new Error("Usage: trawl config set NAME VALUE")
        config.env = {
          ...config.env,
          ...validateEnvironment({ [rest[0]]: rest[1] === "-" ? await io.input() : rest[1] }),
        }
        await writeConfig(config, paths)
        result = publicConfig(config)
      } else if (action === "validate") {
        validateEnvironment(config.env)
        result = { valid: true }
      } else if (action === "import") {
        if (!rest[0]) throw new Error("Missing env file")
        config.env = { ...config.env, ...parseEnvFile(await readTextFile(rest[0])) }
        await writeConfig(config, paths)
        result = publicConfig(config)
      } else if (action === "export") {
        io.out(exportEnvFile(config.env, Boolean(values["include-secrets"])))
        return 0
      } else if (action === "profile") {
        const name = rest[0]
        if (name !== "balanced" && name !== "economy") throw new Error("Profile must be balanced or economy")
        config.env = {
          ...config.env,
          ...profiles[name],
          ...(name === "balanced"
            ? { BROWSER_COLD_BOOT: "false", BROWSER_IDLE_TIMEOUT_MS: "0", WAF_DETECTION_ENABLED: "true" }
            : {}),
        }
        await writeConfig(config, paths)
        result = publicConfig(config)
      } else throw new Error("Unknown config command")
    } else if (command === "runtime") {
      if (action !== "install" || typeof values.from !== "string")
        throw new Error("Usage: trawl runtime install --from <verified-bundle-directory>")
      await installRuntime(values.from, paths)
      result = { installed: true }
    } else if (command === "browser") {
      if (action === "status") result = await browserStatus(paths)
      else if (action === "install") result = await installBrowser(paths, io.signal)
      else if (action === "repair") result = await installBrowser(paths, io.signal, { force: true })
      else if (action === "uninstall") result = await uninstallBrowser(paths)
      else throw new Error("Unknown browser command")
    } else if (command === "doctor")
      result = {
        platform: process.platform,
        arch: process.arch,
        home: paths.home,
        browser: await browserStatus(paths),
        instance: (await control("status", paths)) ?? { running: false },
        configurationValid: true,
      }
    else if (command === "server") {
      if (action === "start") result = await startManaged(paths, "cli", flags)
      else if (action === "stop") result = await stopManaged(paths)
      else if (action === "restart") {
        await stopManaged(paths)
        result = await startManaged(paths, "cli", flags)
      } else if (action === "status") result = (await control("status", paths)) ?? { running: false }
      else if (action === "logs") {
        io.out(await tailLog(paths))
        return 0
      } else throw new Error("Unknown server command")
    } else if (command === "serve") {
      const executable = await runtimeExecutable(paths)
      const child = spawn(executable, ["serve", "--watch-parent", "--home", paths.home], {
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...process.env, ...flags, TRAWL_HOME: paths.home },
      })
      child.stdin?.on("error", () => {})
      const stop = () => child.stdin?.end()
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
      try {
        return await new Promise<number>((resolve, reject) => {
          child.once("exit", (code) => resolve(code ?? 1))
          child.once("error", reject)
        })
      } finally {
        process.removeListener("SIGINT", stop)
        process.removeListener("SIGTERM", stop)
      }
    } else if (command === "service") {
      const { manageService } = await import("@trawl/runtime")
      if (action !== "install" && action !== "uninstall")
        throw new Error("Service command must be install or uninstall")
      result = await manageService(action, paths)
    } else {
      const state = await control("status", paths)
      const baseURL =
        (values["base-url"] as string | undefined) ||
        process.env.TRAWL_BASE_URL ||
        state?.baseURL ||
        "http://localhost:8191"
      const client = new Trawl({
        baseURL,
        apiKey:
          process.env.TRAWL_API_KEY ||
          (!values["base-url"] && !process.env.TRAWL_BASE_URL ? config.env.METRICS_DASHBOARD_TOKEN : undefined) ||
          undefined,
        timeoutMs: number(values.timeout, "timeout"),
      })
      const options = await requestOptions(values.options, io)
      const request = { signal: io.signal }
      if (command === "info") result = await client.info(request)
      else if (command === "health") result = await client.health(request)
      else if (command === "stats") result = await client.stats(request)
      else if (command === "metrics") result = await client.metrics(number(values.minutes, "minutes") ?? 60, request)
      else if (command === "sessions") {
        const [id, target] = rest
        if (!["list", "create"].includes(action) && !id) throw new Error("Missing session ID")
        if (action === "list") result = await client.sessions.list(request)
        else if (action === "create") result = await client.sessions.create(options, request)
        else if (action === "destroy") {
          await client.sessions.destroy(id, request)
          result = { status: "ok" }
        } else if (action === "cookies") result = await client.sessions.cookies(id, request)
        else if (action === "eval") {
          if (typeof options.expression !== "string")
            throw new Error("Session eval requires expression in --options JSON")
          result = await client.sessions.eval(id, options.expression, {
            ...request,
            ...(options.maxTimeout !== undefined
              ? { maxTimeout: number(String(options.maxTimeout), "maxTimeout") }
              : {}),
          })
        } else if (action === "scrape") {
          if (!target && typeof options.url !== "string") throw new Error("Missing scrape URL")
          result = await client.sessions.scrape(
            id,
            { ...options, url: target ?? options.url } as ScrapeRequest,
            request,
          )
        } else throw new Error("Unknown sessions command")
      } else {
        const url = action || options.url
        if (typeof url !== "string") throw new Error("Missing target URL")
        const input = { ...options, url }
        if (command === "scrape") result = await client.scrape(input as ScrapeRequest, request)
        else if (command === "read")
          result = await client.read(
            {
              ...input,
              ...(values.format === "text" ? { format: "text" } : {}),
            } as ReadRequest,
            request,
          )
        else if (command === "extract") result = await client.extract(input as unknown as ExtractRequest, request)
        else if (command === "screenshot") result = await client.screenshot(input as ScreenshotRequest, request)
        else if (command === "inspect") result = await client.inspect(input as InspectRequest, request)
        else throw new Error("Unknown command; use trawl --help")
      }
    }
    const record = result as Record<string, unknown> | undefined
    const output =
      values.format === "html"
        ? String(record?.html ?? "")
        : values.format === "text" || values.format === "markdown"
          ? String(record?.text ?? "")
          : `${JSON.stringify(result, null, 2)}\n`
    if (values.output) {
      if (typeof values.output !== "string") throw new Error("--output requires a path")
      await writeFile(
        values.output,
        command === "screenshot" && typeof record?.screenshot === "string"
          ? Buffer.from(record.screenshot, "base64")
          : output,
      )
    } else io.out(output)
    return 0
  } catch (error) {
    if (io.signal?.aborted) {
      io.err("Command cancelled\n")
      return 130
    }
    io.err(
      `${
        error instanceof TrawlError
          ? `${error.kind}${error.status ? ` (${error.status})` : ""}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "Command failed"
      }\n`,
    )
    return error instanceof TrawlError ? (error.kind === "timeout" ? 4 : error.kind === "aborted" ? 130 : 3) : 2
  }
}
