import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requiredRuntimeFiles, verifyRuntime } from "../src/assets"
import { lockInstance, startControl } from "../src/control"
import { compactLog } from "../src/logs"
import { manage } from "../src/management"
import { runtimePaths } from "../src/paths"

test("runtime replacement refuses an active managed instance and preserves its files", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-active-runtime-"))
  const paths = runtimePaths(home)
  const source = join(home, "source")
  let close: (() => Promise<void>) | undefined
  try {
    const files: Record<string, string> = {}
    for (const name of requiredRuntimeFiles()) {
      await mkdir((await import("node:path")).dirname(join(source, name)), { recursive: true })
      await writeFile(join(source, name), "replacement")
      files[name] = createHash("sha256").update("replacement").digest("hex")
    }
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, files }),
    )
    await mkdir(paths.runtime)
    await writeFile(join(paths.runtime, "previous"), "running version")
    close = await startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})
    await expect(manage({ action: "installRuntime", home, source })).rejects.toThrow("Stop the managed server")
    expect(await readFile(join(paths.runtime, "previous"), "utf8")).toBe("running version")
    await close()
    close = undefined
    const release = await lockInstance(paths)
    try {
      await expect(startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})).rejects.toThrow(
        "already running or starting",
      )
    } finally {
      await release()
    }
    await manage({ action: "installRuntime", home, source })
    expect(await readFile(join(paths.runtime, requiredRuntimeFiles()[0]), "utf8")).toBe("replacement")
  } finally {
    await close?.()
    await rm(home, { recursive: true, force: true })
  }
})

test("runtime verification rejects altered, unlisted and linked resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "trawl-assets-"))
  const digest = createHash("sha256").update("fixture").digest("hex")
  const manifest = {
    version: 1,
    platform: process.platform,
    arch: process.arch,
    files: Object.fromEntries([...requiredRuntimeFiles(), "data/file"].map((name) => [name, digest])),
  }
  try {
    await mkdir(join(root, "data"))
    for (const name of requiredRuntimeFiles()) {
      await mkdir((await import("node:path")).dirname(join(root, name)), { recursive: true })
      await writeFile(join(root, name), "fixture")
    }
    await writeFile(join(root, "data/file"), "fixture")
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest))
    expect((await verifyRuntime(root)).platform).toBe(process.platform)
    await writeFile(join(root, "extra"), "payload")
    await expect(verifyRuntime(root)).rejects.toThrow("unlisted")
    await rm(join(root, "extra"))
    await writeFile(join(root, "data/file"), "changed")
    await expect(verifyRuntime(root)).rejects.toThrow("verification")
    await rm(join(root, "data"), { recursive: true })
    await symlink(tmpdir(), join(root, "data"), process.platform === "win32" ? "junction" : "dir")
    await expect(verifyRuntime(root)).rejects.toThrow("symlinks")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("log compaction preserves append descriptors and bounds retained history", async () => {
  const root = await mkdtemp(join(tmpdir(), "trawl-log-"))
  const path = join(root, "server.log")
  const file = await open(path, "a", 0o600)
  try {
    for (let i = 0; i < 5; i++) {
      await file.writeFile("x".repeat(32))
      await compactLog(path, 16)
    }
    await file.writeFile("still live")
    expect(await readFile(path, "utf8")).toBe("still live")
    expect((await readFile(`${path}.1`)).length).toBe(16)
    await expect(readFile(`${path}.4`)).rejects.toThrow()
  } finally {
    await file.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("failed and interrupted downloads preserve the previous installation", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "helpers/download.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(error).toBe("")
  expect(code).toBe(0)
})
test("unsafe ZIP names are rejected before extraction and replacement rolls back", async () => {
  const AdmZip = (await import("adm-zip")).default
  const { extractVerifiedZip, replaceDirectory } = await import("../src/assets")
  const root = await mkdtemp(join(tmpdir(), "trawl-zip-"))
  try {
    const zip = new AdmZip()
    zip.addFile("safe.txt", Buffer.from("owned"))
    const archive = join(root, "payload.zip")
    await writeFile(
      archive,
      Buffer.from(zip.toBuffer().toString("latin1").replaceAll("safe.txt", "../x.txt"), "latin1"),
    )
    await expect(extractVerifiedZip(archive, join(root, "stage"))).rejects.toThrow("Unsafe")
    const installed = join(root, "installed")
    await mkdir(installed)
    await writeFile(join(installed, "previous"), "known good")
    await expect(replaceDirectory(join(root, "missing"), installed)).rejects.toThrow()
    expect(await readFile(join(installed, "previous"), "utf8")).toBe("known good")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("installers refuse concurrent work on the same destination and release ownership", async () => {
  const { installExclusive } = await import("../src/install-lock")
  const root = await mkdtemp(join(tmpdir(), "trawl-install-lock-"))
  let release: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered: () => void = () => {}
  const acquired = new Promise<void>((resolve) => {
    entered = resolve
  })
  const running = installExclusive(join(root, "runtime"), async () => {
    entered()
    await waiting
    return true
  })
  try {
    await acquired
    await expect(installExclusive(join(root, "runtime"), async () => false)).rejects.toThrow("Another installation")
    release()
    expect(await running).toBe(true)
    expect(await installExclusive(join(root, "runtime"), async () => true)).toBe(true)
  } finally {
    release()
    await running
    await rm(root, { recursive: true, force: true })
  }
})
