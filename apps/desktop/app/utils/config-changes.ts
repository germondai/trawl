import { orderedInstanceIds, type UserConfig } from "@trawl/config/catalog"

export function mergeConfigChanges(baseline: UserConfig, draft: UserConfig, current: UserConfig): UserConfig {
  function merge<T extends object>(before: T, wanted: T, latest: T): T {
    const result = { ...latest }
    for (const key of new Set([...Object.keys(before), ...Object.keys(wanted)]) as Set<keyof T>) {
      if (JSON.stringify(before[key]) === JSON.stringify(wanted[key])) continue
      if (wanted[key] === undefined) delete result[key]
      else result[key] = wanted[key]
    }
    return result
  }
  const desktop = merge(baseline.desktop, draft.desktop, current.desktop)
  if (JSON.stringify(baseline.desktop.instanceOrder) !== JSON.stringify(draft.desktop.instanceOrder)) {
    const before = orderedInstanceIds(baseline.desktop),
      wanted = orderedInstanceIds(draft.desktop)
    const retained = new Set(before.filter((id) => wanted.includes(id)))
    // Adding/removing connections must keep the order of existing instances saved in the meantime.
    if (
      JSON.stringify(before.filter((id) => retained.has(id))) ===
      JSON.stringify(wanted.filter((id) => retained.has(id)))
    ) {
      const latest = orderedInstanceIds(current.desktop)
      desktop.instanceOrder = [
        ...latest.filter((id) => retained.has(id)),
        ...wanted.filter((id) => !before.includes(id)),
      ]
    }
  }
  return {
    ...current,
    env: merge(baseline.env, draft.env, current.env),
    desktop,
  }
}
