import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function command(args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/server.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, out, error }
}
test("native help does not boot an API or require a browser", async () => {
  const result = await command(["--help"])
  expect(result.code).toBe(0)
  expect(result.error).toBe("")
  expect(result.out).toContain("trawl-server setup")
})
test("native executable configures a headless install and validates flags before startup", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-native-command-"))
  try {
    const profile = await command(["profile", "economy", "--home", home])
    expect(profile.code).toBe(0)
    expect(JSON.parse(profile.out).env.BROWSER_COLD_BOOT).toBe("true")
    const invalid = await command(["serve", "--port", "0", "--home", home])
    expect(invalid.code).toBe(1)
    expect(invalid.error).toContain("PORT")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("desktop management completes while its parent pipe stays open", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-parent-rpc-"))
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(import.meta.dir, "../src/server.ts"), "--manage", "--watch-parent"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000)
  timer.unref()
  try {
    child.stdin.write(`${JSON.stringify({ action: "doctor", home })}\n`)
    await child.stdin.flush()
    const response = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(0)
    expect(response).toMatchObject({ ok: true, result: { configValid: true } })
  } finally {
    clearTimeout(timer)
    child.kill()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)

test("a disconnected desktop cancels its download and removes partial assets", async () => {
  const { readdir } = await import("node:fs/promises")
  const home = await mkdtemp(join(tmpdir(), "trawl-parent-download-"))
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "helpers/parent-download.ts"),
      "--manage",
      "--watch-parent",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  timer.unref()
  try {
    child.stdin.write(`${JSON.stringify({ action: "installBrowser", home })}\n`)
    await child.stdin.flush()
    const started = await child.stderr.getReader().read()
    expect(new TextDecoder().decode(started.value)).toContain("download started")
    child.stdin.end()
    const response = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(1)
    expect(response.ok).toBe(false)
    expect((await readdir(home)).some((name) => name.includes("stage-") || name.endsWith(".lock"))).toBe(false)
    expect(await readdir(join(home, "downloads"))).toEqual([])
  } finally {
    clearTimeout(timer)
    child.kill()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)

test("interrupting native browser setup cancels and cleans its partial transfer", async () => {
  if (process.platform === "win32") return // Windows uses the launcher's owned parent pipe instead of POSIX signals.
  const { readdir } = await import("node:fs/promises")
  const home = await mkdtemp(join(tmpdir(), "trawl-interrupt-"))
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(import.meta.dir, "helpers/parent-download.ts"), "setup", "--home", home],
    { stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  timer.unref()
  try {
    const reader = child.stderr.getReader()
    const started = await reader.read()
    expect(new TextDecoder().decode(started.value)).toContain("download started")
    reader.releaseLock()
    child.kill("SIGINT")
    expect(await child.exited).toBe(130)
    expect((await readdir(home)).some((name) => name.includes("stage-") || name.endsWith(".lock"))).toBe(false)
    expect(await readdir(join(home, "downloads"))).toEqual([])
  } finally {
    clearTimeout(timer)
    child.kill()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
