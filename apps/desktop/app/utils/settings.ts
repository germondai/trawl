import type { Setting } from "@trawl/config/catalog"
import { messages } from "@trawl/config/i18n"
import { formatLocale, t } from "./localization"

export const settingSections = [
  {
    id: "general",
    get label() {
      return t("ui.apiRequests")
    },
    get description() {
      return t("ui.whereTrawlListensRequestDeadlinesAndScrapingBehavior")
    },
    groups: ["api", "port", "scrape", "tier1", "flaresolverr"],
  },
  {
    id: "browser",
    get label() {
      return t("ui.browserResources")
    },
    get description() {
      return t("ui.browserCapacityStartupIdleBehaviorAndRecoveryLimits")
    },
    groups: ["browser", "user"],
  },
  {
    id: "sessions",
    get label() {
      return t("ui.sessionsCache")
    },
    get description() {
      return t("ui.reuseVerifiedClearanceAndControlHowLongCached")
    },
    groups: ["session", "redis", "memory"],
  },
  {
    id: "proxies",
    get label() {
      return t("ui.networkProxies")
    },
    get description() {
      return t("ui.chooseThisInstanceSDnsAndConfigureUpstream")
    },
    groups: ["dns", "proxy", "residential"],
  },
  {
    id: "proxy",
    get label() {
      return t("ui.challengeAwareProxy")
    },
    get description() {
      return t("ui.runALocalHttpHttpsProxyThatEscalates")
    },
    groups: ["mitm"],
  },
  {
    id: "challenges",
    get label() {
      return t("ui.challengesCaptcha")
    },
    get description() {
      return t("ui.wafDiagnosticsAudioTranscriptionAndOptionalPaidSolver")
    },
    groups: ["waf", "stt", "ffmpeg", "captcha", "twocaptcha"],
  },
  {
    id: "outputs",
    get label() {
      return t("ui.pageOutputs")
    },
    get description() {
      return t("ui.limitsForScreenshotsCapturedResponsesArchivesAndFavicons")
    },
    groups: ["screenshot", "blocked", "diagnostics", "redirect", "capture", "mhtml", "favicon"],
  },
  {
    id: "metrics",
    get label() {
      return t("ui.metricsLogs")
    },
    get description() {
      return t("ui.dashboardAccessRequestHistoryStorageAndLogVerbosity")
    },
    groups: ["metrics", "log", "history"],
  },
  {
    id: "telemetry",
    get label() {
      return t("ui.usageSharing")
    },
    get description() {
      return t("ui.optionalExplicitlyEnabledSharingWithYourConfiguredStatistics")
    },
    groups: ["telemetry"],
  },
  {
    id: "mcp",
    get label() {
      return t("ui.mcpTools")
    },
    get description() {
      return t("ui.exposeNativeScrapingToolsToCompatibleAiClients")
    },
    groups: ["mcp"],
  },
] as const

const labels: Record<string, string> = {
  get DNS_RESOLVER() {
    return t("ui.instanceDns")
  },
  get DNS_SERVERS() {
    return t("ui.customDnsServers")
  },
  get HOST() {
    return t("ui.listenAddress")
  },
  get PORT() {
    return t("ui.apiPort")
  },
  get SCRAPE_MAX_TIMEOUT_MS() {
    return t("ui.requestTimeout")
  },
  get SCRAPE_MIN_TIER() {
    return t("ui.minimumExecutionTier")
  },
  get TIER1_TRANSPORT() {
    return t("ui.httpTransport")
  },
  get FLARESOLVERR_COOKIE_FALLBACK() {
    return t("ui.flaresolverrCookieFallback")
  },
  get BROWSER_POOL_SIZE() {
    return t("ui.browserPoolSize")
  },
  get BROWSER_HEADFUL_POOL_SIZE() {
    return t("ui.extraHeadfulBrowsers")
  },
  get BROWSER_GEOIP_IP() {
    return t("ui.publicEgressIp")
  },
  get BROWSER_COLD_BOOT() {
    return t("ui.startBrowsersOnDemand")
  },
  get BROWSER_IDLE_TIMEOUT_MS() {
    return t("ui.closeIdleBrowsersAfter")
  },
  get BROWSER_MAX_CONTENT_PROCESSES() {
    return t("ui.contentProcessesPerBrowser")
  },
  get BROWSER_ACQUIRE_TIMEOUT_MS() {
    return t("ui.browserQueueTimeout")
  },
  get BROWSER_RECYCLE_AFTER_CONTEXTS() {
    return t("ui.recycleAfterTemporaryContexts")
  },
  get BROWSER_HARDWARE_CONCURRENCY() {
    return t("ui.reportedCpuCount")
  },
  get BROWSER_BLOCK_ADS() {
    return t("ui.blockAdsAndTrackers")
  },
  get BROWSER_SHUTDOWN_DRAIN_MS() {
    return t("ui.requestDrainOnShutdown")
  },
  get USER_PREFS() {
    return t("ui.advancedFirefoxPreferences")
  },
  get SESSION_CACHE_DRIVER() {
    return t("ui.cacheStorage")
  },
  get REDIS_URL() {
    return t("ui.redisConnectionUrl")
  },
  get REDIS_SESSION_TTL_SECONDS() {
    return t("ui.clearanceCacheLifetime")
  },
  get MEMORY_SESSION_CACHE_MAX_ENTRIES() {
    return t("ui.inMemoryCacheCapacity")
  },
  get BROWSER_SESSION_MAX_ENTRIES() {
    return t("ui.namedSessionsPerBrowser")
  },
  get BROWSER_SESSION_TTL_SECONDS() {
    return t("ui.namedSessionIdleLifetime")
  },
  get SCRAPE_PROXY_SELECTION() {
    return t("ui.proxySelectionStrategy")
  },
  get PROXY_URL() {
    return t("ui.datacenterProxyUrls")
  },
  get PROXY_LIST_FILE() {
    return t("ui.datacenterProxyListFile")
  },
  get RESIDENTIAL_PROXY_URL() {
    return t("ui.residentialProxyUrls")
  },
  get RESIDENTIAL_PROXY_LIST_FILE() {
    return t("ui.residentialProxyListFile")
  },
  get MITM_ENABLED() {
    return t("ui.enableChallengeAwareProxy")
  },
  get MITM_HOST() {
    return t("ui.proxyListenAddress")
  },
  get MITM_PORT() {
    return t("ui.proxyListenPort")
  },
  get MITM_CA_DIR() {
    return t("ui.proxyCertificateDirectory")
  },
  get MITM_MAX_TIER() {
    return t("ui.maximumEscalationTier")
  },
  get MITM_ALWAYS_SCRAPE() {
    return t("ui.alwaysUseTheScraper")
  },
  get MITM_ESCALATE_429() {
    return t("ui.escalateHttp429Responses")
  },
  get MITM_DEBUG() {
    return t("ui.logProxyRequests")
  },
  get STT_URL() {
    return t("ui.speechToTextEndpoint")
  },
  get STT_API_KEY() {
    return t("ui.speechToTextApiKey")
  },
  get STT_MODEL() {
    return t("ui.speechToTextModel")
  },
  get FFMPEG_PATH() {
    return t("ui.customFfmpegPath")
  },
  get CAPTCHA_SOLVER() {
    return t("ui.paidSolverProvider")
  },
  get TWOCAPTCHA_API_KEY() {
    return t("ui.2captchaApiKey")
  },
  get CAPTCHA_SOLVER_PROFILES() {
    return t("ui.hostnameSolverProfiles")
  },
  get WAF_DETECTION_ENABLED() {
    return t("ui.detectWafProviders")
  },
  get METRICS_DASHBOARD_ENABLED() {
    return t("ui.enableDashboardMetrics")
  },
  get METRICS_DASHBOARD_TOKEN() {
    return t("ui.dashboardAccessToken")
  },
  get METRICS_DB_PATH() {
    return t("ui.historyDatabasePath")
  },
  get LOG_LEVEL() {
    return t("ui.logVerbosity")
  },
  get MCP_ENABLED() {
    return t("ui.enableMcpTools")
  },
  get MCP_ALLOWED_ORIGINS() {
    return t("ui.allowedBrowserOrigins")
  },
}
export function settingLabel(setting: Pick<Setting, "name">) {
  const key = `settings.${setting.name}.label`
  if (messages.en[key]) return t(key)
  return (
    labels[setting.name] ??
    setting.name
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/\b(ms|ttl|cpu|ip|url|html|jpeg|mhtml|api)\b/g, (value) => value.toUpperCase())
      .replace(/^./, (value) => value.toUpperCase())
  )
}
export function settingDescription(setting: Pick<Setting, "name" | "description">) {
  for (const key of [`settings.android.${setting.name}.description`, `settings.${setting.name}.description`]) {
    if (messages.en[key] === setting.description) return t(key)
  }
  return setting.description
}
export function sectionFor(setting: Pick<Setting, "name" | "group">): string {
  if (setting.name.startsWith("BROWSER_SESSION_")) return "sessions"
  if (setting.name === "SCRAPE_PROXY_SELECTION") return "proxies"
  return (
    settingSections.find((section) => (section.groups as readonly string[]).includes(setting.group))?.id ?? "general"
  )
}
export function groupedSettings<T extends Pick<Setting, "name" | "group">>(settings: readonly T[]) {
  return settingSections
    .map((section) => ({
      ...section,
      settings: settings.filter((setting) => sectionFor(setting) === section.id),
    }))
    .filter((section) => section.settings.length)
}
export function settingValueHint(setting: Setting, value: string): string {
  if (setting.secret) return value ? t("ui.configuredValueHidden") : t("ui.notConfigured")
  if (value === "") return t("ui.notConfigured")
  const number = Number(value)
  if (setting.name.endsWith("_MS") && Number.isFinite(number))
    return number === 0 ? t("ui.0MsDisabled") : t("counts.seconds", { count: number / 1000 })
  if (setting.name.endsWith("_SECONDS") && Number.isFinite(number)) return t("counts.seconds", { count: number })
  if (setting.name.endsWith("_BYTES") && number > 0)
    return `${(number / 1048576).toLocaleString(formatLocale(), { maximumFractionDigits: 2 })} MiB`
  return value.length > 64 ? `${value.slice(0, 61)}…` : value
}
export function rebaseSettingsDraft(
  draft: Record<string, string>,
  before: Record<string, string>,
  after: Record<string, string>,
) {
  const merged = { ...after }
  for (const name of new Set([...Object.keys(before), ...Object.keys(draft)])) {
    if (draft[name] === before[name]) continue
    if (name in draft) merged[name] = draft[name] as string
    else delete merged[name]
  }
  return merged
}

export type DnsSelection = { resolver: string; servers: string }
export function applyDnsSettings(
  draft: Record<string, string>,
  inherited: Record<string, string>,
  selection: DnsSelection,
) {
  const next = { ...draft }
  if (selection.resolver === (inherited.DNS_RESOLVER ?? "system")) delete next.DNS_RESOLVER
  else next.DNS_RESOLVER = selection.resolver
  if (selection.resolver !== "custom" || selection.servers === (inherited.DNS_SERVERS ?? "")) delete next.DNS_SERVERS
  else next.DNS_SERVERS = selection.servers
  return next
}
