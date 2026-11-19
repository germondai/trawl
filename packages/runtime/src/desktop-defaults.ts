import type { Environment } from "@trawl/config"

export const desktopHistoryDefaults: Environment = {
  HISTORY_CAPTURE_REQUESTS: "true",
  HISTORY_CAPTURE_MODE: "html",
  HISTORY_CAPTURE_MAX_BYTES: "262144",
  HISTORY_CAPTURE_STORAGE_BYTES: "16777216",
  HISTORY_CAPTURE_MAX_RECORDS: "100",
  HISTORY_CAPTURE_TTL_SECONDS: "86400",
}

/** Respect saved/environment overrides, including an explicit opt-out. */
export function applyDesktopHistoryDefaults(values: Environment, sources: Record<string, string>) {
  if (values.OBSERVABILITY_ENABLED !== "true") return {}
  return Object.fromEntries(Object.entries(desktopHistoryDefaults).filter(([name]) => sources[name] === "default"))
}
