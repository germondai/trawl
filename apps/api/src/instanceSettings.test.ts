import { describe, expect, test } from "bun:test"
import { settings } from "@trawl/config/catalog"
import { readInstanceSettings } from "./instanceSettings"

describe("effective instance settings", () => {
  test("covers the shared catalog without exposing secrets or unknown environment variables", () => {
    const snapshot = readInstanceSettings()
    expect(snapshot.readOnly).toBe(true)
    expect(snapshot.settings.map(({ name }) => name)).toEqual(settings.map(({ name }) => name))
    expect(snapshot.settings.filter(({ secret }) => secret).every(({ value }) => value === null)).toBe(true)
    expect(snapshot.settings.find(({ name }) => name === "USER_PREFS")?.secret).toBe(true)
    expect(snapshot.settings.find(({ name }) => name === "STT_URL")?.secret).toBe(true)
    expect(snapshot.settings.find(({ name }) => name === "DNS_RESOLVER")?.value).toBe("system")
    expect(snapshot.settings.find(({ name }) => name === "DNS_SERVERS")?.value).toBe("")
  })

  test("reports normalized values actually used by the engine and never returns configured credentials", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--no-env-file",
        "-e",
        'console.log(JSON.stringify((await import("./instanceSettings.ts")).readInstanceSettings()))',
      ],
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH,
        BROWSER_POOL_SIZE: "invalid",
        BROWSER_BLOCK_ADS: "no",
        SCREENSHOT_JPEG_QUALITY: "101",
        LOG_LEVEL: " DEBUG ",
        DNS_RESOLVER: "cloudflare",
        MITM_HOST: "127.0.0.1",
        SCREENSHOT_MAX_BYTES: "10",
        METRICS_DASHBOARD_TOKEN: "private-test-token-abcdefghijklmnopqrstuvwxyz",
        USER_PREFS: '{"network.proxy.password":"private-value"}',
        STT_URL: "https://private-key@stt.example/transcribe",
        UNRELATED_PRIVATE_KEY: "private-value",
      },
      timeout: 10_000,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const source = result.stdout.toString()
    expect(source).not.toMatch(/private-value|private-key|private-test-token|UNRELATED_PRIVATE_KEY/)
    const snapshot = JSON.parse(source)
    const setting = (name: string) => snapshot.settings.find((item: { name: string }) => item.name === name)
    expect(setting("BROWSER_POOL_SIZE")).toMatchObject({ value: "1", source: "normalized" })
    expect(setting("BROWSER_BLOCK_ADS").value).toBe("false")
    expect(setting("SCREENSHOT_JPEG_QUALITY").value).toBe("60")
    expect(setting("SCREENSHOT_MAX_BYTES").value).toBe("10")
    expect(setting("MITM_HOST").value).toBe("127.0.0.1")
    expect(setting("LOG_LEVEL").value).toBe("debug")
    expect(setting("DNS_RESOLVER")).toMatchObject({ value: "cloudflare", source: "environment" })
    expect(setting("METRICS_DASHBOARD_TOKEN")).toMatchObject({ value: null, configured: true })
  })

  test("fails closed when observability is enabled without its token", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--no-env-file", "-e", 'await import("./config.ts")'],
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH, OBSERVABILITY_ENABLED: "true" },
      timeout: 10_000,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("OBSERVABILITY_ENABLED requires")
  })
})
