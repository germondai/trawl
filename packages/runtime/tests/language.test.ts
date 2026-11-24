import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runtimePaths } from "../src/paths"
import { emptyConfig, readConfig, validateConfig, writeConfig } from "../src/store"

test("language preference defaults, migrates and persists without changing user configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "trawl-language-"))
  const paths = runtimePaths(root)
  try {
    const config = emptyConfig()
    expect(config.desktop.language).toBe("system")
    expect(config.desktop.localName).toBeUndefined()
    const { language: _, ...legacy } = config.desktop
    expect(validateConfig({ ...config, desktop: legacy }).desktop.language).toBe("system")
    config.env.PORT = "8192"
    config.desktop.localName = "Příliš žluťoučký {name}"
    config.desktop.connections = [{ id: "owned", name: "Privé", baseURL: "https://owned.example" }]
    for (const language of ["en", "cs", "sk", "pl", "de", "fr", "system"] as const) {
      config.desktop.language = language
      await writeConfig(config, paths)
      expect(await readConfig(paths)).toEqual(config)
    }
    const unknown = { ...config, desktop: { ...config.desktop, language: "unknown" } }
    expect(() => validateConfig(unknown)).toThrow("preferences")
    await writeFile(paths.config, JSON.stringify(unknown), { mode: 0o600 })
    expect(await readConfig(paths)).toEqual({ ...config, desktop: { ...config.desktop, language: "en" } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("interaction feedback is opt-in and persists independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "trawl-feedback-"))
  const paths = runtimePaths(root)
  try {
    const config = await readConfig(paths)
    expect(config.desktop.interactionSounds).toBe(false)
    expect(config.desktop.hapticFeedback).toBe(false)
    for (const [interactionSounds, hapticFeedback] of [
      [true, false],
      [false, true],
    ] as const) {
      Object.assign(config.desktop, { interactionSounds, hapticFeedback })
      await writeConfig(config, paths)
      expect((await readConfig(paths)).desktop).toEqual(config.desktop)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
