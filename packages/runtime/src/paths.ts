import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function runtimePaths(root?: string) {
  const home = homedir()
  const base = resolve(
    root ??
      process.env.TRAWL_HOME ??
      (process.platform === "win32"
        ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "TRAWL")
        : process.platform === "darwin"
          ? join(home, "Library", "Application Support", "TRAWL")
          : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "trawl")),
  )
  return {
    home: base,
    config: join(base, "config.json"),
    run: join(base, "run"),
    state: join(base, "run", "instance.json"),
    log: join(base, "logs", "server.log"),
    browser: join(base, "browser"),
    runtime: join(base, "runtime"),
    metrics: join(base, "metrics.sqlite"),
    ca: join(base, "proxy-ca"),
  }
}
export type RuntimePaths = ReturnType<typeof runtimePaths>
