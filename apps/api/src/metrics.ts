import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { PoolExhaustedError } from "@trawl/browser"
import { ScrapeError, sanitizeWafDetails } from "@trawl/tiers"
import type {
  ActiveRequest,
  RequestDiagnostics,
  RequestHistoryEntry,
  RequestHistoryQuery,
  RequestHistoryResponse,
  RequestLifecycle,
  TierResult,
  WafDetection,
} from "@trawl/types"
import { METRICS_DASHBOARD_ENABLED, METRICS_DASHBOARD_TOKEN, METRICS_DB_PATH, OBSERVABILITY_ENABLED } from "./config"
import { EventJournal } from "./eventJournal"
import type { ScrapeSource } from "./requestLogging"
import { usageTelemetry } from "./usageTelemetry"

type Tier = 0 | 1 | 2 | 3 | 4
type FailureCategory = "blocked" | "timeout" | "capacity" | "network" | "http" | "internal"
type Severity = "warning" | "error"
type Range = 15 | 60 | 1440 | 10080 | 43200
export const metricRanges = [15, 60, 1440, 10080, 43200] as const
const MAX_EVENTS = 50_000
const RETENTION_MS = 30 * 24 * 60 * 60_000

export interface MetricEvent {
  diagnostics?: RequestDiagnostics
  challenge?: string
  requestId?: string
  method?: string
  source: ScrapeSource
  url: string
  durationMs: number
  tier?: Tier
  attempts?: TierResult[]
  statusCode?: number
  error?: unknown
  waf?: WafDetection
}

interface StoredEvent {
  id: number
  request_id: string
  method: string | null
  at: number
  domain: string
  source: ScrapeSource
  duration_ms: number
  success: number
  tier: Tier | null
  tier_status: TierResult["status"] | null
  status_code: number | null
  category: FailureCategory | null
  severity: Severity | null
  diagnostics_json: string | null
  waf_json: string | null
}

export interface WafTotals {
  states: Record<WafDetection["state"], number>
  unavailable: Partial<Record<NonNullable<WafDetection["reason"]>, number>>
  durationMs: number
  timed: number
  providers: { product: string; requests: number; failures: number }[]
}

function storedWaf(waf: WafDetection | undefined): WafDetection | undefined {
  if (!waf) return
  return {
    engine: waf.engine,
    version: waf.version,
    state: waf.state,
    products: [...new Set(waf.products)].slice(0, 256),
    ...sanitizeWafDetails(waf),
    sourceTier: waf.sourceTier,
    durationMs: Number.isFinite(waf.durationMs) && (waf.durationMs ?? -1) >= 0 ? waf.durationMs : undefined,
    reason: waf.reason,
  }
}

function readWaf(value: string | null): WafDetection | undefined {
  if (!value) return
  try {
    return JSON.parse(value) as WafDetection
  } catch {
    return
  }
}

const TIERS = [0, 1, 2, 3, 4] as const
const SOURCES = ["native", "flaresolverr", "mcp", "proxy"] as const
const CATEGORIES = ["blocked", "timeout", "capacity", "network", "http", "internal"] as const

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().slice(0, 253) || "unknown"
  } catch {
    return "unknown"
  }
}

function failureKind(
  error: unknown,
  attempts: TierResult[],
  statusCode?: number,
): { category: FailureCategory; severity: Severity } {
  if (error instanceof PoolExhaustedError) return { category: "capacity", severity: "warning" }
  const terminal = attempts.at(-1)
  if (terminal?.status === "blocked" || terminal?.status === "needs-js") {
    return { category: "blocked", severity: "warning" }
  }
  if (terminal?.status === "timeout") return { category: "timeout", severity: "warning" }
  if (statusCode === 403 || statusCode === 429) return { category: "blocked", severity: "warning" }
  if (statusCode && statusCode >= 400) return { category: "http", severity: statusCode >= 500 ? "error" : "warning" }
  if (error instanceof ScrapeError && /timeout|timed out|deadline/i.test(error.message)) {
    return { category: "timeout", severity: "warning" }
  }
  if (error instanceof Error && /ECONN|ENOTFOUND|EAI_AGAIN|network|socket|TLS/i.test(error.message)) {
    return { category: "network", severity: "warning" }
  }
  return { category: "internal", severity: "error" }
}

function historyEntry(row: StoredEvent): RequestHistoryEntry {
  return {
    id: row.request_id,
    at: new Date(row.at).toISOString(),
    domain: row.domain,
    source: row.source,
    method: row.method,
    durationMs: row.duration_ms,
    success: Boolean(row.success),
    tier: row.tier,
    tierStatus: row.tier_status,
    statusCode: row.status_code,
    category: row.category,
    severity: row.severity,
    ...(row.diagnostics_json ? { diagnostics: JSON.parse(row.diagnostics_json) as RequestDiagnostics } : {}),
  }
}

export class MetricsStore {
  readonly events = new EventJournal<RequestLifecycle>()
  private active = new Map<string, { request: ActiveRequest; finish: () => void }>()
  private activeCount = 0
  private db?: Database
  private listeners = new Set<() => void>()
  private recorded = 0
  private wafCounts: Omit<WafTotals, "providers"> = {
    states: { complete: 0, incomplete: 0, unavailable: 0 },
    unavailable: {},
    durationMs: 0,
    timed: 0,
  }
  private wafProviders = new Map<string, { requests: number; failures: number }>()

  constructor(
    enabled = true,
    path = ":memory:",
    private readonly live = OBSERVABILITY_ENABLED,
  ) {
    if (!enabled) return
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.db.run("PRAGMA busy_timeout = 1000")
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, domain TEXT NOT NULL, source TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, success INTEGER NOT NULL, tier INTEGER, tier_status TEXT,
      status_code INTEGER, category TEXT, severity TEXT, waf_json TEXT
    )`)
    const db = this.db
    const schema = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    if (schema > 2) {
      db.close()
      throw new Error("Request-history schema is newer than this server supports")
    }
    db.transaction(() => {
      const columns = new Set(
        (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map(({ name }) => name),
      )
      if (!columns.has("waf_json")) db.run("ALTER TABLE events ADD COLUMN waf_json TEXT")
      if (!columns.has("request_id")) db.run("ALTER TABLE events ADD COLUMN request_id TEXT")
      if (!columns.has("method")) db.run("ALTER TABLE events ADD COLUMN method TEXT")
      db.run("UPDATE events SET request_id = 'legacy-' || lower(hex(randomblob(16))) WHERE request_id IS NULL")
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS events_request_id ON events(request_id)")
      if (!columns.has("diagnostics_json")) db.run("ALTER TABLE events ADD COLUMN diagnostics_json TEXT")
      db.run("PRAGMA user_version = 2")
    }).immediate()
    this.db.run(`CREATE TABLE IF NOT EXISTS tier_attempts (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      tier INTEGER NOT NULL
    )`)
    this.db.run("CREATE INDEX IF NOT EXISTS events_at ON events(at)")
    this.db.run(
      "CREATE INDEX IF NOT EXISTS events_summary ON events(at, source, tier, success, category, severity, duration_ms)",
    )
    this.db.run("CREATE INDEX IF NOT EXISTS events_domain_summary ON events(domain, at, success)")
    this.db.run("CREATE INDEX IF NOT EXISTS attempts_at ON tier_attempts(at)")
    this.prune()
  }

  close(): void {
    this.listeners.clear()
    this.events.close()
    this.active.clear()
    this.activeCount = 0
    this.db?.close()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get clientRequestIds(): boolean {
    return this.live && Boolean(this.db)
  }

  acceptRequestId(candidate: string | null): string | undefined {
    if (
      !this.live ||
      !this.db ||
      !candidate ||
      this.activeCount > this.active.size ||
      this.active.size >= 256 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate) ||
      this.active.has(candidate)
    )
      return
    try {
      if (!this.db.query("SELECT 1 FROM events WHERE request_id = ?").get(candidate)) return candidate
    } catch {
      /* Observation storage must not break an ordinary request. */
    }
  }

  startRequest(id: string, source: ScrapeSource, url: string, method = "GET"): (() => void) | undefined {
    if (!this.live || !this.db) return
    const existing = this.active.get(id)
    if (existing) return existing.finish
    const request: ActiveRequest = { id, source, domain: domainOf(url), method, startedAt: new Date().toISOString() }
    let finished = false
    this.activeCount++
    const finish = () => {
      if (finished) return
      finished = true
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.active.delete(id)
    }
    // Overflow cleanup lives with the in-flight operation, not an unbounded retained ID set.
    if (this.active.size < 256) this.active.set(id, { request, finish })
    this.events.publish({ type: "started", request })
    return finish
  }

  history(limit = 50, before?: string, query: RequestHistoryQuery = {}): RequestHistoryResponse {
    const count = Math.min(100, Math.max(1, Math.floor(limit)))
    const db = this.db
    let bound = Number.MAX_SAFE_INTEGER
    if (before && db) {
      const row = db.query("SELECT id FROM events WHERE request_id = ?").get(before) as { id: number } | null
      if (!row) throw new Error("History cursor is no longer available; reload the first page")
      bound = row.id
    }
    const predicates = ["at >= ?", "id < ?"]
    const values: (string | number)[] = [Date.now() - RETENTION_MS, bound]
    if (query.search) {
      predicates.push(
        "instr(lower(domain || ' ' || source || ' ' || coalesce(category, '') || ' ' || request_id), ?) > 0",
      )
      values.push(query.search.toLowerCase())
    }
    if (query.source) {
      predicates.push("source = ?")
      values.push(query.source)
    }
    if (query.result) {
      predicates.push("success = ?")
      values.push(Number(query.result === "success"))
    }
    if (query.tier !== undefined) {
      predicates.push("tier = ?")
      values.push(query.tier)
    }
    const where = predicates.join(" AND ")
    const order = {
      newest: "id DESC",
      oldest: "id ASC",
      slowest: "duration_ms DESC, id DESC",
      fastest: "duration_ms ASC, id DESC",
    }[query.sort ?? "newest"]
    const total = db
      ? (db.query(`SELECT COUNT(*) AS count FROM events WHERE ${where}`).get(...values) as { count: number }).count
      : 0
    const rows = db
      ? (db
          .query(`SELECT * FROM events WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
          .all(...values, count + 1, ((query.page ?? 1) - 1) * count) as StoredEvent[])
      : []
    const page = rows.slice(0, count)
    return {
      entries: page.map(historyEntry),
      total,
      page: query.page ?? 1,
      nextCursor: rows.length > count ? (page.at(-1)?.request_id ?? null) : null,
      cursor: this.events.cursor,
      active: [...this.active.values()].map(({ request }) => request),
      activeTruncated: this.activeCount > this.active.size,
    }
  }

  request(id: string): RequestHistoryEntry | undefined {
    const row = this.db
      ?.query("SELECT * FROM events WHERE request_id = ? AND at >= ?")
      .get(id, Date.now() - RETENTION_MS) as StoredEvent | null | undefined
    return row ? { ...historyEntry(row), ...(row.waf_json ? { waf: readWaf(row.waf_json) } : {}) } : undefined
  }

  wafTotals(): WafTotals {
    return {
      ...this.wafCounts,
      states: { ...this.wafCounts.states },
      unavailable: { ...this.wafCounts.unavailable },
      providers: [...this.wafProviders].map(([product, counts]) => ({ product, ...counts })),
    }
  }

  private recordWaf(waf: WafDetection, success: boolean): void {
    this.wafCounts.states[waf.state]++
    if (waf.state === "unavailable" && waf.reason)
      this.wafCounts.unavailable[waf.reason] = (this.wafCounts.unavailable[waf.reason] ?? 0) + 1
    if (waf.durationMs !== undefined) {
      this.wafCounts.durationMs += waf.durationMs
      this.wafCounts.timed++
    }
    for (const product of waf.products) {
      const counts = this.wafProviders.get(product)
      if (counts) {
        counts.requests++
        counts.failures += Number(!success)
      } else if (this.wafProviders.size < 256) {
        this.wafProviders.set(product, { requests: 1, failures: Number(!success) })
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private prune(): void {
    const db = this.db
    if (!db) return
    const cutoff = Date.now() - RETENTION_MS
    db.query("DELETE FROM events WHERE at < ?").run(cutoff)
    db.query("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)").run(MAX_EVENTS)
    db.query(
      "DELETE FROM tier_attempts WHERE at < ? OR (event_id IS NULL AND id NOT IN (SELECT id FROM tier_attempts WHERE event_id IS NULL ORDER BY id DESC LIMIT ?))",
    ).run(cutoff, MAX_EVENTS)
  }

  recordTierZeroAttempt(): void {
    if (!this.db) return
    try {
      this.db.query("INSERT INTO tier_attempts(at, tier) VALUES (?, 0)").run(Date.now())
      if (++this.recorded % 100 === 0) this.prune()
      this.notify()
    } catch (error) {
      console.error("[metrics] failed to record tier attempt:", error)
    }
  }

  record(event: MetricEvent): void {
    try {
      usageTelemetry.record({
        url: event.url,
        challenge: event.challenge,
        success:
          event.error === undefined &&
          event.statusCode !== undefined &&
          event.statusCode >= 200 &&
          event.statusCode < 400,
        durationMs: event.durationMs,
      })
    } catch {
      /* Optional usage sharing must not change request processing. */
    }
    const db = this.db
    const rawWaf = event.waf ?? (event.error instanceof ScrapeError ? event.error.waf : undefined)
    if (!db && !rawWaf) return
    const at = Date.now()
    const id = event.requestId ?? randomUUID()
    const attempts = event.attempts ?? (event.error instanceof ScrapeError ? event.error.timings : [])
    const success =
      event.error === undefined && event.statusCode !== undefined && event.statusCode >= 200 && event.statusCode < 400
    const failure = success ? null : failureKind(event.error, attempts, event.statusCode)
    let persisted = false
    try {
      const waf = storedWaf(rawWaf)
      if (waf) this.recordWaf(waf, success)
      if (!db) return
      db.transaction(() => {
        const inserted = db
          .query(`INSERT INTO events(at, domain, source, duration_ms, success, tier, tier_status, status_code, category, severity, waf_json, request_id, method, diagnostics_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            at,
            domainOf(event.url),
            event.source,
            Math.max(0, Math.round(event.durationMs)),
            Number(success),
            event.tier ?? attempts.at(-1)?.tier ?? null,
            attempts.at(-1)?.status ?? null,
            event.statusCode ?? null,
            failure?.category ?? null,
            failure?.severity ?? null,
            waf ? JSON.stringify(waf) : null,
            id,
            event.method ?? this.active.get(id)?.request.method ?? null,
            event.diagnostics ? JSON.stringify(event.diagnostics) : null,
          )
        for (const attempt of attempts) {
          if (attempt.status !== "skipped") {
            db.query("INSERT INTO tier_attempts(at, event_id, tier) VALUES (?, ?, ?)").run(
              at,
              inserted.lastInsertRowid,
              attempt.tier,
            )
          }
        }
      })()
      persisted = true
      if (++this.recorded % 100 === 0) this.prune()
      this.notify()
    } catch (error) {
      // Metrics must never change the result of a scrape.
      console.error("[metrics] failed to record request:", error)
    } finally {
      const method = event.method ?? this.active.get(id)?.request.method ?? null
      this.active.get(id)?.finish()
      if (this.live && db)
        this.events.publish({
          type: success ? "completed" : "failed",
          persisted,
          request: {
            id,
            at: new Date(at).toISOString(),
            domain: domainOf(event.url),
            source: event.source,
            method,
            durationMs: Math.max(0, Math.round(event.durationMs)),
            success,
            tier: event.tier ?? attempts.at(-1)?.tier ?? null,
            tierStatus: attempts.at(-1)?.status ?? null,
            statusCode: event.statusCode ?? null,
            category: failure?.category ?? null,
            severity: failure?.severity ?? null,
            ...(event.diagnostics ? { diagnostics: event.diagnostics } : {}),
          },
        })
    }
  }

  snapshot(minutes: Range = 60) {
    const range = metricRanges.includes(minutes) ? minutes : 60
    const now = Date.now()
    const from = now - range * 60_000
    const db = this.db
    const step =
      range <= 60 ? 60_000 : range <= 1440 ? 30 * 60_000 : range <= 10080 ? 4 * 60 * 60_000 : 24 * 60 * 60_000
    const groups = db
      ? (db
          .query(`SELECT (at / ?) * ? AS at, source, tier,
      COUNT(*) AS requests, SUM(success) AS successes, SUM(duration_ms) AS duration_ms, MAX(duration_ms) AS maximum_ms FROM events WHERE at >= ?
      GROUP BY (at / ?), source, tier`)
          .all(step, step, from, step) as (Pick<StoredEvent, "at" | "source" | "tier" | "duration_ms"> & {
          requests: number
          successes: number
          maximum_ms: number
        })[])
      : []
    const failureGroups = db
      ? (db
          .query(`SELECT category, severity, COUNT(*) AS count FROM events
          WHERE at >= ? AND success = 0 GROUP BY category, severity`)
          .all(from) as {
          category: FailureCategory | null
          severity: Severity | null
          count: number
        }[])
      : []
    const events = db
      ? (db.query("SELECT * FROM events WHERE at >= ? ORDER BY id DESC LIMIT 100").all(from) as StoredEvent[])
      : []
    const failures = db
      ? (db
          .query("SELECT * FROM events WHERE at >= ? AND success = 0 ORDER BY id DESC LIMIT 50")
          .all(from) as StoredEvent[])
      : []
    const attempts = db
      ? (db.query("SELECT tier, COUNT(*) AS count FROM tier_attempts WHERE at >= ? GROUP BY tier").all(from) as {
          tier: Tier
          count: number
        }[])
      : []
    const wafGroups = db
      ? (db
          .query(`SELECT json_extract(waf_json, '$.state') AS state,
          json_extract(waf_json, '$.reason') AS reason, COUNT(*) AS count,
          SUM(json_extract(waf_json, '$.durationMs')) AS duration,
          COUNT(json_extract(waf_json, '$.durationMs')) AS timed
          FROM events WHERE at >= ? AND waf_json IS NOT NULL GROUP BY state, reason`)
          .all(from) as {
          state: WafDetection["state"]
          reason: WafDetection["reason"]
          count: number
          duration: number | null
          timed: number
        }[])
      : []
    const providers = db
      ? (db
          .query(`SELECT p.value AS product, COUNT(*) AS requests, SUM(1 - e.success) AS failures
          FROM events e, json_each(e.waf_json, '$.products') p WHERE e.at >= ?
          GROUP BY p.value ORDER BY requests DESC, product LIMIT 256`)
          .all(from) as WafTotals["providers"])
      : []
    const wafStates: WafTotals["states"] = { complete: 0, incomplete: 0, unavailable: 0 }
    const wafUnavailable: WafTotals["unavailable"] = {}
    let wafDuration = 0
    let wafTimed = 0
    for (const row of wafGroups) {
      wafStates[row.state] += row.count
      if (row.state === "unavailable" && row.reason)
        wafUnavailable[row.reason] = (wafUnavailable[row.reason] ?? 0) + row.count
      wafDuration += row.duration ?? 0
      wafTimed += row.timed
    }
    const bySource = Object.fromEntries(SOURCES.map((source) => [source, 0])) as Record<ScrapeSource, number>
    const byTier = Object.fromEntries(TIERS.map((tier) => [tier, { attempts: 0, successes: 0 }])) as Record<
      Tier,
      { attempts: number; successes: number }
    >
    const byFailure = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<FailureCategory, number>
    const bySeverity: Record<Severity, number> = { warning: 0, error: 0 }
    const domains = db
      ? (db
          .query(`SELECT domain, COUNT(*) AS requests, SUM(1 - success) AS failures FROM events
      WHERE at >= ? GROUP BY domain ORDER BY failures DESC, MAX(id) DESC LIMIT 20`)
          .all(from) as { domain: string; requests: number; failures: number }[])
      : []
    let requests = 0
    let successes = 0
    let duration = 0
    let maximumMs = 0
    for (const row of attempts) byTier[row.tier].attempts = row.count
    for (const row of groups) {
      requests += row.requests
      bySource[row.source] += row.requests
      duration += row.duration_ms
      maximumMs = Math.max(maximumMs, row.maximum_ms)
      successes += row.successes
      if (row.tier !== null) byTier[row.tier].successes += row.successes
    }
    for (const row of failureGroups) {
      if (row.category) byFailure[row.category] += row.count
      if (row.severity) bySeverity[row.severity] += row.count
    }
    const end = Math.floor(now / step) * step
    const size = Math.ceil((range * 60_000) / step) + 1
    const bins = new Map<
      number,
      {
        requests: number
        failures: number
        durationMs: number
        sources: Record<string, number>
        tiers: Record<string, number>
      }
    >()
    for (const row of groups) {
      const key = Math.floor(row.at / step) * step
      const bucket = bins.get(key) ?? { requests: 0, failures: 0, durationMs: 0, sources: {}, tiers: {} }
      bucket.requests += row.requests
      bucket.failures += row.requests - row.successes
      bucket.durationMs += row.duration_ms
      bucket.sources[row.source] = (bucket.sources[row.source] ?? 0) + row.requests
      if (row.tier !== null) bucket.tiers[row.tier] = (bucket.tiers[row.tier] ?? 0) + row.requests
      bins.set(key, bucket)
    }
    const timeline = Array.from({ length: size }, (_, index) => {
      const key = end - (size - index - 1) * step
      const bucket = bins.get(key) ?? { requests: 0, failures: 0, durationMs: 0, sources: {}, tiers: {} }
      return {
        minute: new Date(key).toISOString(),
        requests: bucket.requests,
        failures: bucket.failures,
        averageMs: bucket.requests ? Math.round(bucket.durationMs / bucket.requests) : 0,
        sources: bucket.sources,
        tiers: bucket.tiers,
      }
    })
    const first = db?.query("SELECT MIN(at) AS at FROM events").get() as { at: number | null } | undefined
    return {
      startedAt: first?.at ? new Date(first.at).toISOString() : null,
      rangeMinutes: range,
      retainedEvents: db ? (db.query("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count : 0,
      requests,
      successes,
      failures: requests - successes,
      averageMs: requests ? Math.round(duration / requests) : 0,
      maximumMs,
      bySource,
      byTier,
      byFailure,
      bySeverity,
      waf: {
        observations: wafStates.complete + wafStates.incomplete + wafStates.unavailable,
        states: wafStates,
        unavailable: wafUnavailable,
        averageMs: wafTimed ? Math.round((wafDuration / wafTimed) * 100) / 100 : 0,
        providers,
      },
      bucketMs: step,
      timeline,
      lastHour: timeline,
      domains,
      recentEvents: events.slice(0, 100).map((row) => ({
        id: row.request_id,
        at: new Date(row.at).toISOString(),
        domain: row.domain,
        source: row.source,
        durationMs: row.duration_ms,
        success: Boolean(row.success),
        tier: row.tier,
        tierStatus: row.tier_status,
        statusCode: row.status_code,
        category: row.category,
        severity: row.severity,
        ...(row.waf_json ? { waf: readWaf(row.waf_json) } : {}),
      })),
      recentFailures: failures.map((row) => ({
        at: new Date(row.at).toISOString(),
        domain: row.domain,
        source: row.source,
        tier: row.tier,
        tierStatus: row.tier_status,
        statusCode: row.status_code,
        category: row.category,
        severity: row.severity,
        ...(row.waf_json ? { waf: readWaf(row.waf_json) } : {}),
      })),
    }
  }
}

export const metrics = new MetricsStore(
  Boolean(METRICS_DASHBOARD_TOKEN) || METRICS_DASHBOARD_ENABLED || OBSERVABILITY_ENABLED,
  METRICS_DB_PATH,
)
