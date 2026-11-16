import { type Environment, profiles, resolveEnvironment } from "@trawl/config"
import type { RuntimePaths } from "./paths"

export function resolveManagedEnvironment(
  paths: RuntimePaths,
  file: Environment = {},
  env: Record<string, string | undefined> = process.env,
  flags: Environment = {},
) {
  const resolved = resolveEnvironment(file, env, flags, profiles.balanced)
  if (resolved.sources.METRICS_DB_PATH === "default" || !resolved.values.METRICS_DB_PATH)
    resolved.values.METRICS_DB_PATH = paths.metrics
  if (resolved.sources.MITM_CA_DIR === "default" || !resolved.values.MITM_CA_DIR) resolved.values.MITM_CA_DIR = paths.ca
  return resolved
}
