import { isIP } from "node:net"
import { defaults, type Environment, settingByName, settings } from "./catalog"

export {
  type Connection,
  defaults,
  type Environment,
  emptyConfig,
  profiles,
  type Setting,
  settingByName,
  settings,
  type UserConfig,
} from "./catalog"

export function validateEnvironment(input: unknown): Environment {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Settings must be an object")
  const output: Environment = {}
  for (const [name, raw] of Object.entries(input)) {
    const setting = settingByName.get(name)
    if (!setting) throw new Error(`Unknown setting: ${name}`)
    if (!["string", "number", "boolean"].includes(typeof raw)) throw new Error(`${name} must be a scalar value`)
    const value = String(raw).trim()
    if (value === "") {
      if (setting.default !== "" && (setting.kind !== "string" || name === "HOST"))
        throw new Error(`${name} cannot be empty`)
      output[name] = ""
      continue
    }
    if (Buffer.byteLength(value) > (setting.kind === "json" ? 65536 : 8192))
      throw new Error(`${name} exceeds its size limit`)
    if (name === "HOST" && value.length > 253) throw new Error("HOST exceeds its size limit")
    let valid = true
    if (setting.kind === "boolean") valid = /^(true|false)$/i.test(value)
    if (setting.kind === "integer")
      valid =
        /^\d+$/.test(value) &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) >= (setting.min ?? 0) &&
        Number(value) <= (setting.max ?? 2147483647)
    if (setting.kind === "enum") valid = setting.choices?.includes(value) ?? false
    if (setting.kind === "ip") valid = isIP(value) > 0 && !value.includes("%")
    if (setting.kind === "json") {
      try {
        const parsed = JSON.parse(value)
        valid =
          name === "USER_PREFS"
            ? parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            : Array.isArray(parsed)
      } catch {
        valid = false
      }
    }
    if (
      name === "HOST" &&
      !isIP(value) &&
      !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
        value,
      )
    )
      valid = false
    if (/[\0\r\n]/.test(value)) valid = false
    if (!valid) throw new Error(`${name} has an invalid ${setting.kind} value`)
    if (name === "METRICS_DASHBOARD_TOKEN" && value.length < 32)
      throw new Error(`${name} must contain at least 32 characters`)
    output[name] = setting.kind === "boolean" ? value.toLowerCase() : value
  }
  return output
}

export function resolveEnvironment(
  file: Environment = {},
  env: Record<string, string | undefined> = {},
  flags: Environment = {},
  baseline: Environment = {},
) {
  const inherited = Object.fromEntries(
    settings.flatMap(({ name }) => (env[name] === undefined ? [] : [[name, env[name]]])),
  )
  const values = {
    ...defaults,
    ...validateEnvironment(baseline),
    ...validateEnvironment(file),
    ...validateEnvironment(inherited),
    ...validateEnvironment(flags),
  }
  const sources = Object.fromEntries(
    settings.map(({ name }) => [
      name,
      name in flags ? "flag" : name in inherited ? "environment" : name in file ? "file" : "default",
    ]),
  )
  return { values, sources }
}

export function redactEnvironment(env: Environment): Environment {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, settingByName.get(name)?.secret && value ? "[redacted]" : value]),
  )
}

export function parseEnvFile(source: string): Environment {
  const values: Environment = {}
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim())
    if (!match) throw new Error("Invalid environment file assignment")
    let value = match[2]
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        throw new Error(`Invalid quoted value for ${match[1]}`)
      }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, "").trim()
    values[match[1]] = value
  }
  return validateEnvironment(values)
}

export function exportEnvFile(env: Environment, includeSecrets = false): string {
  return `${Object.entries(includeSecrets ? env : redactEnvironment(env))
    .filter(([, value]) => value !== "[redacted]")
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n")}\n`
}

export const settingFlags = () =>
  Object.fromEntries(settings.map(({ name }) => [name.toLowerCase().replaceAll("_", "-"), { type: "string" as const }]))
export function flagEnvironment(values: Record<string, unknown>): Environment {
  return validateEnvironment(
    Object.fromEntries(
      settings.flatMap(({ name }) => {
        const value = values[name.toLowerCase().replaceAll("_", "-")]
        return value === undefined ? [] : [[name, value]]
      }),
    ),
  )
}
