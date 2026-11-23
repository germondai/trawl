import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type InstallationProgress, installationProgress } from "../src/progress"
import { fixtureChildEnv } from "./helpers/child-env"

test("installation progress is throttled, phase scoped and estimates only measured work", () => {
  let now = 0
  const clock = spyOn(performance, "now").mockImplementation(() => now)
  const events: InstallationProgress[] = []
  try {
    const report = installationProgress((value) => events.push(value))
    report({ phase: "download", completed: 0, total: 100, unit: "bytes" })
    now = 100
    report({ phase: "download", completed: 10, total: 100, unit: "bytes" })
    expect(events).toHaveLength(1)
    expect(events[0]?.etaMs).toBeUndefined()
    now = 1000
    report({ phase: "download", completed: 50, total: 100, unit: "bytes" })
    expect(events.at(-1)?.etaMs).toBe(1000)
    now = 1050
    report({ phase: "download", completed: 100, total: 100, unit: "bytes" })
    expect(events.at(-1)?.completed).toBe(100)
    expect(events.at(-1)?.etaMs).toBeUndefined()
    report({ phase: "extract", completed: 0, total: 10, unit: "files" })
    expect(events.at(-1)?.elapsedMs).toBe(0)
    expect(events.at(-1)?.etaMs).toBeUndefined()
  } finally {
    clock.mockRestore()
  }
})
test("private management progress reaches the parent while stdin stays open", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-progress-"))
  await mkdir(join(home, "browser", "owned"), { recursive: true })
  await writeFile(join(home, "browser", "owned", "fixture"), "owned")
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../src/server.ts"),
      "--manage",
      "--watch-parent",
      "--progress",
    ],
    {
      env: fixtureChildEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(process.platform === "win32" ? 25000 : 10000),
    },
  )
  try {
    child.stdin.write(`${JSON.stringify({ action: "uninstallBrowser", home })}\n`)
    await child.stdin.flush()
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit).toBe(0)
    expect(JSON.parse(stdout).ok).toBe(true)
    const steps = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as InstallationProgress)
    expect(steps.at(-1)?.phase).toBe("done")
    const removal = steps.findLast((step) => step.phase === "remove" && step.total !== undefined)
    expect(removal?.completed).toBe(3)
    expect(removal?.total).toBe(3)
  } finally {
    child.stdin.end()
    if (child.exitCode === null) child.kill()
    await child.exited
    await rm(home, { recursive: true, force: true })
  }
})

test("resumed progress estimates new work and resets when a server restarts the download", () => {
  let now = 0
  const clock = spyOn(performance, "now").mockImplementation(() => now)
  const events: InstallationProgress[] = []
  try {
    const report = installationProgress((value) => events.push(value))
    report({ phase: "download", completed: 800, total: 1000, unit: "bytes" })
    now = 1000
    report({ phase: "download", completed: 900, total: 1000, unit: "bytes" })
    expect(events.at(-1)?.etaMs).toBe(1000)
    report({ phase: "download", completed: 0, total: 1000, unit: "bytes" })
    expect(events.at(-1)?.elapsedMs).toBe(0)
    now = 2000
    report({ phase: "download", completed: 250, total: 1000, unit: "bytes" })
    expect(events.at(-1)?.etaMs).toBe(3000)
  } finally {
    clock.mockRestore()
  }
})
