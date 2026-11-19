import { usageReporter } from "@trawl/telemetry"
import pkg from "../package.json"
import { TELEMETRY_ENABLED, TELEMETRY_ENDPOINT } from "./config"
export const usageTelemetry = usageReporter({
  enabled: TELEMETRY_ENABLED,
  endpoint: TELEMETRY_ENDPOINT,
  version: pkg.version,
})
