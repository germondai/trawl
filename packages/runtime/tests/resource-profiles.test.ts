import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { manage } from "../src/management"
import { runtimePaths } from "../src/paths"
import { emptyConfig, readConfig, validateConfig, writeConfig } from "../src/store"

test("resource presets leave binding, cache and unrelated overrides untouched", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-profile-"))
  const paths = runtimePaths(home)
  try {
    const config = emptyConfig()
    Object.assign(config.env, {
      HOST: "0.0.0.0",
      MITM_HOST: "0.0.0.0",
      SESSION_CACHE_DRIVER: "redis",
      MEMORY_SESSION_CACHE_MAX_ENTRIES: "321",
      PORT: "8999",
      BROWSER_POOL_SIZE: "4",
    })
    await writeConfig(config, paths)
    for (const profile of ["economy", "balanced"] as const) {
      await manage({ action: "profile", profile, home })
      const next = await readConfig(paths)
      for (const key of [
        "HOST",
        "MITM_HOST",
        "SESSION_CACHE_DRIVER",
        "MEMORY_SESSION_CACHE_MAX_ENTRIES",
        "PORT",
        "BROWSER_POOL_SIZE",
      ])
        expect(next.env[key]).toBe(config.env[key])
      expect(next.env.BROWSER_COLD_BOOT).toBe(profile === "economy" ? "true" : "false")
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("retired custom presets are ignored without losing actual environment overrides", () => {
  const config = emptyConfig()
  config.env.BROWSER_POOL_SIZE = "3"
  const checked = validateConfig({
    ...config,
    desktop: { ...config.desktop, customResourceProfile: { BROWSER_POOL_SIZE: "8" } },
  })
  expect(checked.env.BROWSER_POOL_SIZE).toBe("3")
  expect("customResourceProfile" in checked.desktop).toBe(false)
})
