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
