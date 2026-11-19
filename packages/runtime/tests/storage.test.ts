import { expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lockInstance } from "../src/control"
import { manage } from "../src/management"
import { runtimePaths } from "../src/paths"

test("managed cleanup removes selected data and keeps configuration, browser and unrelated files", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-clear-"))
  try {
    for (const name of ["logs", "downloads", "browser", "captures"]) {
      await mkdir(join(home, name))
      await writeFile(join(home, name, "fixture"), "owned")
    }
    for (const name of ["config.json", "metrics.sqlite", "metrics.sqlite-wal", "metrics.sqlite-shm"])
      await writeFile(join(home, name), "owned")
    await manage({ action: "clearStorage", home, storage: "logs" })
    expect(
      await access(join(home, "logs")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(await readFile(join(home, "metrics.sqlite"), "utf8")).toBe("owned")
    await writeFile(join(home, "captures", "index.sqlite"), "capture index")
    await manage({ action: "clearStorage", home, storage: "captures" })
    expect(
      await access(join(home, "captures")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    for (const name of ["metrics.sqlite", "metrics.sqlite-wal", "metrics.sqlite-shm", "config.json"])
      expect(await readFile(join(home, name), "utf8")).toBe("owned")
    await mkdir(join(home, "captures"))
    await writeFile(join(home, "captures", "fixture"), "owned")
    await manage({ action: "clearStorage", home, storage: "history" })
    for (const name of ["captures", "metrics.sqlite", "metrics.sqlite-wal", "metrics.sqlite-shm"])
      expect(
        await access(join(home, name)).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    for (const name of ["config.json", "browser/fixture", "downloads/fixture"])
      expect(await readFile(join(home, name), "utf8")).toBe("owned")
    await manage({ action: "clearStorage", home, storage: "downloads" })
    expect(
      await access(join(home, "downloads")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("cleanup rejects traversal, redirected roots and a starting instance without deleting data", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-clear-"))
  const outside = await mkdtemp(join(tmpdir(), "trawl-keep-"))
  try {
    await writeFile(join(outside, "keep"), "outside")
    await expect(manage({ action: "clearStorage", home, storage: "../browser" })).rejects.toThrow("Unknown")
    await symlink(outside, join(home, "logs"))
    await expect(manage({ action: "clearStorage", home, storage: "logs" })).rejects.toThrow("symbolic link")
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("outside")
    await rm(join(home, "logs"))
    await mkdir(join(home, "logs"))
    await writeFile(join(home, "logs", "keep"), "log")
    const release = await lockInstance(runtimePaths(home))
    try {
      await expect(manage({ action: "clearStorage", home, storage: "logs" })).rejects.toThrow("running or starting")
    } finally {
      await release()
    }
    expect(await readFile(join(home, "logs", "keep"), "utf8")).toBe("log")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("download cache cleanup works while the server runs and preserves active installations", async () => {
  const { startControl } = await import("../src/control")
  const home = await mkdtemp(join(tmpdir(), "trawl-live-cache-")),
    paths = runtimePaths(home)
  let close: (() => Promise<void>) | undefined
  try {
    await mkdir(join(home, "downloads"))
    await writeFile(join(home, "downloads", "partial"), "interrupted")
    await mkdir(paths.browser)
    await writeFile(join(paths.browser, "keep"), "active browser")
    close = await startControl(paths, { owner: "desktop", baseURL: "http://127.0.0.1:8191" }, () => {})
    expect(await manage({ action: "clearStorage", home, storage: "downloads" })).toEqual({ cleared: "downloads" })
    expect(await readFile(join(paths.browser, "keep"), "utf8")).toBe("active browser")
    expect(await manage({ action: "status", home })).toMatchObject({ running: true })
  } finally {
    await close?.()
    await rm(home, { recursive: true, force: true })
  }
})
