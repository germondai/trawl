import { readFileSync } from "node:fs"

// A page closed by the memory limit should not start another expensive solve.
export function anubisOomKills(): number | undefined {
  try {
    const match = readFileSync("/sys/fs/cgroup/memory.events", "utf8").match(/^oom_kill (\d+)$/m)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}
