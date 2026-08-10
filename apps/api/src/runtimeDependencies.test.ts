import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("API runtime image dependencies", () => {
  for (const dockerfile of ["Dockerfile", "Dockerfile.baseline"]) {
    test(`${dockerfile} installs ffmpeg in the runtime stage`, () => {
      const source = readFileSync(resolve(import.meta.dir, "..", dockerfile), "utf8")
      const runtimeStart = source.lastIndexOf("\nFROM ")
      expect(runtimeStart).toBeGreaterThan(0)
      const runtime = source.slice(runtimeStart)
      expect(runtime).toMatch(/apt-get install[\s\S]*\bffmpeg\b/)
    })
  }
})
