import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  defaults,
  exportEnvFile,
  parseEnvFile,
  profiles,
  redactEnvironment,
  resolveEnvironment,
  settings,
  validateEnvironment,
} from "../src"

describe("shared settings", () => {
  test("covers every documented setting without duplicate names", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8")
    const names = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1])
    expect(names.every((name) => name in defaults)).toBe(true)
    expect(new Set(settings.map(({ name }) => name)).size).toBe(settings.length)
    expect(validateEnvironment(defaults)).toEqual(defaults)
  })
  test("resolves flags over environment over file over defaults with provenance", () => {
    const result = resolveEnvironment(
      { PORT: "8000", LOG_LEVEL: "debug" },
      { PORT: "8100", BROWSER_POOL_SIZE: "2" },
      { PORT: "8200" },
    )
    expect(result.values.PORT).toBe("8200")
    expect(result.sources).toMatchObject({
      PORT: "flag",
      LOG_LEVEL: "file",
      BROWSER_POOL_SIZE: "environment",
      HOST: "default",
    })
  })
  test("rejects invalid input without echoing secret values", () => {
    for (const value of [
      { PORT: "0" },
      { PORT: "65536" },
      { MCP_ENABLED: "perhaps" },
      { BROWSER_GEOIP_IP: "https://secret.invalid" },
      { USER_PREFS: "[]" },
      { BROWSER_SHUTDOWN_DRAIN_MS: "2147453648" },
      { UNKNOWN: "value" },
    ])
      expect(() => validateEnvironment(value)).toThrow()
    expect(() => validateEnvironment({ STT_API_KEY: "secret\nvalue" })).toThrow(
      "STT_API_KEY has an invalid string value",
    )
  })
  test("round trips quoted env values and redacts secrets by default", () => {
    const env = { STT_API_KEY: 'private"value', USER_PREFS: '{"pref":true}', BROWSER_POOL_SIZE: "1" }
    expect(parseEnvFile(exportEnvFile(env, true))).toEqual(env)
    expect(exportEnvFile(env)).not.toContain("private")
    expect(redactEnvironment(env).STT_API_KEY).toBe("[redacted]")
    expect(parseEnvFile("PORT=8191 # comment\n# hello\nMCP_ENABLED=false\n")).toEqual({
      PORT: "8191",
      MCP_ENABLED: "false",
    })
  })
  test("economy retains the documented engine limits and keeps cold boot opt-in", () => {
    expect(defaults.BROWSER_COLD_BOOT).toBe("false")
    expect(profiles.economy).toMatchObject({ BROWSER_COLD_BOOT: "true", BROWSER_IDLE_TIMEOUT_MS: "1800000" })
  })
})
