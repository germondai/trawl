import { readFileSync } from "node:fs"
import { log } from "./logger"

const MIB = 1024 * 1024
const V2 = "/sys/fs/cgroup"
const V1 = "/sys/fs/cgroup/memory"

export interface RuntimeMemory {
  currentBytes: number | null
  limitBytes: number | null
  recommendedLimitBytes: number
  underProvisioned: boolean
  oomEvents: number
  oomKills: number
}

type Reader = (path: string) => string
const systemReader: Reader = (path) => readFileSync(path, "utf8").trim()
const number = (value: string | undefined): number | null => {
  if (!value || value === "max") return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
const events = (raw: string | undefined): Record<string, number> =>
  Object.fromEntries(
    (raw ?? "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((pair) => pair.length === 2)
      .map(([key, value]) => [key, Number(value) || 0]),
  )

export function recommendedMemoryBytes(poolSize: number, headfulPoolSize = 0): number {
  return (1 + poolSize + headfulPoolSize) * 512 * MIB
}

export function readRuntimeMemory(
  poolSize: number,
  headfulPoolSize = 0,
  read: Reader = systemReader,
): RuntimeMemory | undefined {
  const recommendedLimitBytes = recommendedMemoryBytes(poolSize, headfulPoolSize)
  try {
    const currentBytes = number(read(`${V2}/memory.current`))
    const limitBytes = number(read(`${V2}/memory.max`))
    const parsed = events(read(`${V2}/memory.events`))
    return {
      currentBytes,
      limitBytes,
      recommendedLimitBytes,
      underProvisioned: limitBytes !== null && limitBytes < recommendedLimitBytes,
      oomEvents: parsed.oom ?? 0,
      oomKills: parsed.oom_kill ?? 0,
    }
  } catch {}
  try {
    const currentBytes = number(read(`${V1}/memory.usage_in_bytes`))
    const rawLimit = number(read(`${V1}/memory.limit_in_bytes`))
    const limitBytes = rawLimit !== null && rawLimit < Number.MAX_SAFE_INTEGER / 2 ? rawLimit : null
    const oom = events(read(`${V1}/memory.oom_control`))
    return {
      currentBytes,
      limitBytes,
      recommendedLimitBytes,
      underProvisioned: limitBytes !== null && limitBytes < recommendedLimitBytes,
      oomEvents: oom.oom_kill ?? 0,
      oomKills: oom.oom_kill ?? 0,
    }
  } catch {
    return undefined
  }
}

export function startMemoryMonitor(poolSize: number, headfulPoolSize = 0, intervalMs = 30_000): () => void {
  let previous = readRuntimeMemory(poolSize, headfulPoolSize)
  if (previous?.underProvisioned) {
    log("warn", "memory", {
      event: "memory.under_provisioned",
      limitMiB: previous.limitBytes === null ? null : Math.round(previous.limitBytes / MIB),
      recommendedMiB: Math.round(previous.recommendedLimitBytes / MIB),
      poolSize,
      action: "reduce BROWSER_POOL_SIZE or raise the container memory limit",
    })
  }
  const timer = setInterval(() => {
    const current = readRuntimeMemory(poolSize, headfulPoolSize)
    if (current && previous && current.oomKills > previous.oomKills) {
      log("error", "memory", {
        event: "memory.oom_kill",
        newKills: current.oomKills - previous.oomKills,
        totalKills: current.oomKills,
        currentMiB: current.currentBytes === null ? null : Math.round(current.currentBytes / MIB),
      })
    }
    previous = current
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
