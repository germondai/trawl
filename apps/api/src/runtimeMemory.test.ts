import { describe, expect, test } from "bun:test"
import { readRuntimeMemory, recommendedMemoryBytes } from "./runtimeMemory"

describe("runtime memory diagnostics", () => {
  test("reads cgroup v2 usage, limit, and OOM counters", () => {
    const files: Record<string, string> = {
      "/sys/fs/cgroup/memory.current": "600000000",
      "/sys/fs/cgroup/memory.max": "1073741824",
      "/sys/fs/cgroup/memory.events": "low 0\noom 21\noom_kill 6\n",
    }
    const memory = readRuntimeMemory(3, 0, (path) => {
      const value = files[path]
      if (value === undefined) throw new Error("missing")
      return value
    })

    expect(memory).toEqual({
      currentBytes: 600000000,
      limitBytes: 1073741824,
      recommendedLimitBytes: 2147483648,
      underProvisioned: true,
      oomEvents: 21,
      oomKills: 6,
    })
  })

  test("treats an unlimited cgroup as unbounded", () => {
    const memory = readRuntimeMemory(1, 0, (path) => {
      if (path.endsWith("memory.current")) return "100"
      if (path.endsWith("memory.max")) return "max"
      if (path.endsWith("memory.events")) return "oom 0\noom_kill 0"
      throw new Error("missing")
    })
    expect(memory?.limitBytes).toBeNull()
    expect(memory?.underProvisioned).toBeFalse()
    expect(recommendedMemoryBytes(1)).toBe(1024 * 1024 * 1024)
  })

  test("returns undefined outside supported cgroups", () => {
    expect(
      readRuntimeMemory(1, 0, () => {
        throw new Error("missing")
      }),
    ).toBeUndefined()
  })
})

describe("working-set memory", () => {
  test.each([
    ["/sys/fs/cgroup", "memory.current", "memory.max", "memory.events", "inactive_file"],
    [
      "/sys/fs/cgroup/memory",
      "memory.usage_in_bytes",
      "memory.limit_in_bytes",
      "memory.oom_control",
      "total_inactive_file",
    ],
  ])("subtracts inactive file cache for %s", (root, current, limit, oom, inactive) => {
    const files: Record<string, string> = {
      [`${root}/${current}`]: "950000000",
      [`${root}/${limit}`]: "1073741824",
      [`${root}/${oom}`]: "oom_kill 0",
      [`${root}/memory.stat`]: `${inactive} 400000000\nshmem 10000000\n`,
    }
    const result = readRuntimeMemory(1, 0, (path) => {
      if (!(path in files)) throw Error("missing")
      return files[path]
    })
    expect(result?.currentBytes).toBe(950000000)
    expect(result?.workingSetBytes).toBe(550000000)
  })
})
