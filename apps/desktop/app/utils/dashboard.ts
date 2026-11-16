import type { DashboardSnapshot, HealthResponse } from "@trawl/client"

export type ActivityBucket = DashboardSnapshot["timeline"][number]
export function activityIndex(clientX: number, left: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0
  return Math.round(Math.min(1, Math.max(0, (clientX - left) / width)) * (count - 1))
}
export function activityPoints(rows: readonly ActivityBucket[], field: "requests" | "failures"): string {
  const max = Math.max(1, ...rows.map((row) => row.requests))
  return rows
    .map(
      (row, index) => `${rows.length > 1 ? (index / (rows.length - 1)) * 1000 : 500},${160 - (row[field] / max) * 140}`,
    )
    .join(" ")
}
export function capacitySegments(pool: HealthResponse["pool"]) {
  const total = Math.max(0, pool.total)
  let remaining = total
  return [
    { key: "available", label: "Available", value: pool.available },
    { key: "busy", label: "Busy", value: pool.busy },
    { key: "sleeping", label: "Sleeping", value: pool.sleeping ?? 0 },
    { key: "unavailable", label: "Not ready", value: total },
  ].map((segment) => {
    const value = Math.min(remaining, Math.max(0, segment.value))
    remaining -= value
    return { ...segment, value, percent: total ? (value / total) * 100 : 0 }
  })
}
export function executionTier(tier: number | null): string {
  const names: Record<number, string> = {
    0: "Direct forwarding",
    1: "Direct HTTP",
    2: "Cached session",
    3: "Browser",
    4: "Residential proxy",
  }
  return tier === null ? "Not recorded" : (names[tier] ?? "Not recorded")
}
