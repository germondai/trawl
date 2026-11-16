import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { browserStatus } from "./browser"
import { rotateLog, runtimeExecutable, stopManaged } from "./manager"
import { type RuntimePaths, runtimePaths } from "./paths"

const exec = promisify(execFile)
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
const unitQuote = (value: string) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`
export function serviceDefinition(executable: string, paths: RuntimePaths, platform = process.platform) {
  if (/[\r\n\0]/.test(executable + paths.home)) throw new Error("Service paths cannot contain control characters")
  const id = `trawl-${createHash("sha256").update(paths.home).digest("hex").slice(0, 12)}`
  const args = [executable, "serve", "--home", paths.home, "--owner", "cli", "--service"]
  if (platform === "darwin")
    return {
      id: `com.germondai.${id}`,
      path: join(homedir(), "Library/LaunchAgents", `com.germondai.${id}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.germondai.${id}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>${xml(paths.log)}</string><key>StandardErrorPath</key><string>${xml(paths.log)}</string></dict></plist>`,
    }
  if (platform === "linux")
    return {
      id: `${id}.service`,
      path: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user", `${id}.service`),
      content: `[Unit]\nDescription=TRAWL scraping server\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args.map(unitQuote).join(" ")}\nRestart=no\nKillMode=control-group\nTimeoutStopSec=300\n\n[Install]\nWantedBy=default.target\n`,
    }
  if (platform === "win32") {
    const quote = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
    return {
      id: `TRAWL-${id}`,
      path: join(paths.home, "autostart.xml"),
      content: `<?xml version="1.0" encoding="UTF-8"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>TRAWL user scraping server</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${xml(executable)}</Command><Arguments>${xml(args.slice(1).map(quote).join(" "))}</Arguments><WorkingDirectory>${xml(dirname(executable))}</WorkingDirectory></Exec></Actions></Task>`,
    }
  }
  throw new Error("Unsupported service platform")
}
export async function manageService(action: "install" | "uninstall", paths = runtimePaths()) {
  const definition = serviceDefinition(await runtimeExecutable(paths), paths)
  if (action === "install") {
    if (!(await browserStatus(paths)).installed) throw new Error("Install the browser before enabling a service")
    await rotateLog(paths)
    await mkdir(dirname(definition.path), { recursive: true })
    await writeFile(definition.path, definition.content, { mode: 0o600 })
  }
  if (action === "uninstall") await stopManaged(paths, "cli")
  if (process.platform === "darwin") {
    const uid = process.getuid?.()
    if (uid === undefined) throw new Error("Cannot determine login identity")
    if (action === "install") await exec("launchctl", ["bootstrap", `gui/${uid}`, definition.path], { timeout: 10000 })
    else await exec("launchctl", ["bootout", `gui/${uid}/${definition.id}`], { timeout: 10000 })
  } else if (process.platform === "linux") {
    await exec("systemctl", ["--user", "daemon-reload"], { timeout: 10000 })
    await exec("systemctl", ["--user", action === "install" ? "enable" : "disable", "--now", definition.id], {
      timeout: 10000,
    })
  } else if (process.platform === "win32") {
    await exec(
      "schtasks",
      action === "install"
        ? ["/Create", "/TN", definition.id, "/XML", definition.path]
        : ["/Delete", "/TN", definition.id, "/F"],
      { timeout: 10000 },
    )
  }
  if (action === "uninstall") {
    await rm(definition.path, { force: true })
    if (process.platform === "linux") await exec("systemctl", ["--user", "daemon-reload"], { timeout: 10000 })
  }
  return { installed: action === "install", name: definition.id }
}
