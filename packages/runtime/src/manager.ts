import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, open } from "node:fs/promises"
import { join } from "node:path"
import { type Environment, validateEnvironment } from "@trawl/config"
import { control, type InstanceStatus } from "./control"
import { compactLog } from "./logs"
import { type RuntimePaths, runtimePaths } from "./paths"
import { privateDirectory, readConfig } from "./store"

export async function runtimeExecutable(paths = runtimePaths()): Promise<string> {
  const name = process.platform === "win32" ? "trawl-server.exe" : "trawl-server"
  const executable = process.env.TRAWL_RUNTIME_EXECUTABLE || join(paths.runtime, name)
  try {
    await access(executable, constants.X_OK)
  } catch {
    throw new Error("TRAWL runtime is not installed. Install a verified runtime bundle first.")
  }
  return executable
}
export async function rotateLog(paths = runtimePaths()) {
  await privateDirectory(join(paths.home, "logs"))
  await compactLog(paths.log)
}
export async function startManaged(
  paths: RuntimePaths = runtimePaths(),
  owner: "cli" | "desktop" = "cli",
  flags: Environment = {},
): Promise<InstanceStatus> {
  const running = await control("status", paths)
  if (running && running.ready !== false) return running
  let child: ReturnType<typeof spawn> | undefined
  let failure: Error | undefined
  if (!running) {
    await readConfig(paths)
    const executable = await runtimeExecutable(paths)
    await rotateLog(paths)
    const file = await open(paths.log, "a", 0o600)
    child = spawn(executable, ["serve", "--home", paths.home, "--owner", owner], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", file.fd, file.fd],
      env: { ...process.env, ...validateEnvironment(flags), TRAWL_HOME: paths.home },
    })
    await file.close()
    child.unref()
    child.once("error", (error) => {
      failure = error
    })
  }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (failure) throw failure
    const status = await control("status", paths)
    if (status && status.ready !== false) return status
    if ((child && child.exitCode !== null) || (running && !status))
      throw new Error("Server startup failed; inspect trawl server logs")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Server did not become ready; inspect trawl server logs")
}
export async function stopManaged(paths = runtimePaths(), requiredOwner?: "desktop" | "cli", signal?: AbortSignal) {
  const current = await control("status", paths)
  if (!current) return { running: false }
  if (requiredOwner && current.owner !== requiredOwner) return { ...current, stopped: false }
  await control("stop", paths)
  const config = await readConfig(paths)
  const deadline =
    Date.now() +
    Math.min(current.shutdownDrainMs ?? Number(config.env.BROWSER_SHUTDOWN_DRAIN_MS || 0), 2147453647) +
    30000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (!(await control("status", paths))) return { running: false }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Server shutdown timed out; the process was not killed by an unverified PID")
}
