import type { Setting } from "@trawl/config/catalog"

export const settingSections = [
  {
    id: "general",
    label: "API & requests",
    description: "Where TRAWL listens, request deadlines and scraping behavior.",
    groups: ["api", "port", "scrape", "tier1", "flaresolverr"],
  },
  {
    id: "browser",
    label: "Browser & resources",
    description: "Browser capacity, startup, idle behavior and recovery limits.",
    groups: ["browser", "user"],
  },
  {
    id: "sessions",
    label: "Sessions & cache",
    description: "Reuse verified clearance and control how long cached sessions stay available.",
    groups: ["session", "redis", "memory"],
  },
  {
    id: "proxies",
    label: "Upstream proxies",
    description: "Route browser requests through your datacenter or residential proxies.",
    groups: ["proxy", "residential"],
  },
  {
    id: "proxy",
    label: "Challenge-aware proxy",
    description: "Run a local HTTP/HTTPS proxy that escalates detected challenge pages.",
    groups: ["mitm"],
  },
  {
    id: "challenges",
    label: "Challenges & CAPTCHA",
    description: "WAF diagnostics, audio transcription and optional paid solver fallback.",
    groups: ["waf", "stt", "ffmpeg", "captcha", "twocaptcha"],
  },
  {
    id: "outputs",
    label: "Page outputs",
    description:
      "Limits for screenshots, captured responses, archives and favicons. These features stay opt-in per request.",
    groups: ["screenshot", "blocked", "diagnostics", "redirect", "capture", "mhtml", "favicon"],
  },
  {
    id: "metrics",
    label: "Metrics & logs",
    description: "Dashboard access, request history storage and log verbosity.",
    groups: ["metrics", "log", "history"],
  },
  {
    id: "mcp",
    label: "MCP tools",
    description: "Expose native scraping tools to compatible AI clients.",
    groups: ["mcp"],
  },
] as const

const labels: Record<string, string> = {
  HOST: "Listen address",
  PORT: "API port",
  SCRAPE_MAX_TIMEOUT_MS: "Request timeout",
  SCRAPE_MIN_TIER: "Minimum execution tier",
  TIER1_TRANSPORT: "HTTP transport",
  FLARESOLVERR_COOKIE_FALLBACK: "FlareSolverr cookie fallback",
  BROWSER_POOL_SIZE: "Browser pool size",
  BROWSER_HEADFUL_POOL_SIZE: "Extra headful browsers",
  BROWSER_GEOIP_IP: "Public egress IP",
  BROWSER_COLD_BOOT: "Start browsers on demand",
  BROWSER_IDLE_TIMEOUT_MS: "Close idle browsers after",
  BROWSER_MAX_CONTENT_PROCESSES: "Content processes per browser",
  BROWSER_ACQUIRE_TIMEOUT_MS: "Browser queue timeout",
  BROWSER_RECYCLE_AFTER_CONTEXTS: "Recycle after temporary contexts",
  BROWSER_HARDWARE_CONCURRENCY: "Reported CPU count",
  BROWSER_BLOCK_ADS: "Block ads and trackers",
  BROWSER_SHUTDOWN_DRAIN_MS: "Request drain on shutdown",
  USER_PREFS: "Advanced Firefox preferences",
  SESSION_CACHE_DRIVER: "Cache storage",
  REDIS_URL: "Redis connection URL",
  REDIS_SESSION_TTL_SECONDS: "Clearance cache lifetime",
  MEMORY_SESSION_CACHE_MAX_ENTRIES: "In-memory cache capacity",
  BROWSER_SESSION_MAX_ENTRIES: "Named sessions per browser",
  BROWSER_SESSION_TTL_SECONDS: "Named session idle lifetime",
  SCRAPE_PROXY_SELECTION: "Proxy selection strategy",
  PROXY_URL: "Datacenter proxy URLs",
  PROXY_LIST_FILE: "Datacenter proxy list file",
  RESIDENTIAL_PROXY_URL: "Residential proxy URLs",
  RESIDENTIAL_PROXY_LIST_FILE: "Residential proxy list file",
  MITM_ENABLED: "Enable challenge-aware proxy",
  MITM_HOST: "Proxy listen address",
  MITM_PORT: "Proxy listen port",
  MITM_CA_DIR: "Proxy certificate directory",
  MITM_MAX_TIER: "Maximum escalation tier",
  MITM_ALWAYS_SCRAPE: "Always use the scraper",
  MITM_ESCALATE_429: "Escalate HTTP 429 responses",
  MITM_DEBUG: "Log proxy requests",
  STT_URL: "Speech-to-text endpoint",
  STT_API_KEY: "Speech-to-text API key",
  STT_MODEL: "Speech-to-text model",
  FFMPEG_PATH: "Custom FFmpeg path",
  CAPTCHA_SOLVER: "Paid solver provider",
  TWOCAPTCHA_API_KEY: "2Captcha API key",
  CAPTCHA_SOLVER_PROFILES: "Hostname solver profiles",
  WAF_DETECTION_ENABLED: "Detect WAF providers",
  METRICS_DASHBOARD_ENABLED: "Enable dashboard metrics",
  METRICS_DASHBOARD_TOKEN: "Dashboard access token",
  METRICS_DB_PATH: "History database path",
  LOG_LEVEL: "Log verbosity",
  MCP_ENABLED: "Enable MCP tools",
  MCP_ALLOWED_ORIGINS: "Allowed browser origins",
}
export function settingLabel(setting: Pick<Setting, "name">) {
  return (
    labels[setting.name] ??
    setting.name
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/\b(ms|ttl|cpu|ip|url|html|jpeg|mhtml|api)\b/g, (value) => value.toUpperCase())
      .replace(/^./, (value) => value.toUpperCase())
  )
}
export function sectionFor(setting: Pick<Setting, "name" | "group">): string {
  if (setting.name.startsWith("BROWSER_SESSION_")) return "sessions"
  if (setting.name === "SCRAPE_PROXY_SELECTION") return "proxies"
  return (
    settingSections.find((section) => (section.groups as readonly string[]).includes(setting.group))?.id ?? "general"
  )
}
export function settingValueHint(setting: Setting, value: string): string {
  if (setting.secret) return value ? "Configured · value hidden" : "Not configured"
  if (value === "") return "Not configured"
  const number = Number(value)
  if (setting.name.endsWith("_MS") && Number.isFinite(number))
    return number === 0 ? "0 ms · disabled" : `${(number / 1000).toLocaleString()} seconds`
  if (setting.name.endsWith("_SECONDS") && Number.isFinite(number)) return `${number.toLocaleString()} seconds`
  if (setting.name.endsWith("_BYTES") && number > 0)
    return `${(number / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`
  return value.length > 64 ? `${value.slice(0, 61)}…` : value
}
