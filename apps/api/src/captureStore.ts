import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, constants, existsSync, lstatSync, mkdirSync } from "node:fs"
import { open, opendir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import type { ArtifactKind, CaptureMode, RequestArtifact, RequestCaptures } from "@trawl/types"

export interface CapturePolicy {
  mode: CaptureMode
  artifactBytes: number
  totalBytes: number
  records: number
  retentionMs: number
  fallbackHtml: boolean
}
export const defaultCapturePolicy: Readonly<CapturePolicy> = Object.freeze({
  mode: "none",
  artifactBytes: 2 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  records: 500,
  retentionMs: 7 * 86400000,
  fallbackHtml: false,
})
interface Row {
  request_id: string
  request_at: string
  created: number
  mode: CaptureMode
  data: string
  stored_bytes: number
  files: number
  pending: number
}
interface Input {
  requestId: string
  requestAt: string
  html?: string
  contentType?: string
  screenshot?: Uint8Array
  screenshotReason?: string
  capturedAt?: string
  htmlTruncated?: boolean
}
interface Job {
  manifest: RequestCaptures
  parts: Map<ArtifactKind, Uint8Array>
  reservation: number
}
const INDEX_RECORDS = 50000
const INDEX_RETENTION_MS = 30 * 86400000
const APPLICATION_ID = 0x54524350
const kinds = ["html", "screenshot"] as const
const validId = (value: string) => /^[A-Za-z0-9_-]{1,80}$/.test(value)
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

/** Optional private artifact storage. A single bounded writer owns reservations, eviction and atomic publication. */
export class CaptureStore {
  readonly ready: Promise<void>
  failure: string | undefined
  private db: Database | undefined
  private jobs: Job[] = []
  private reserved = 0
  private used = 0
  private readers = 0
  private rowCount = 0
  private invalid = new Map<string, string>()
  private worker: Promise<void> | undefined
  private pruneNeeded = false
  private closed = false
  private initialized = false
  private timer: ReturnType<typeof setInterval> | undefined

  get enabled(): boolean {
    return this.initialized && !this.closed && Boolean(this.db) && !this.failure && this.policy.mode !== "none"
  }
  get available(): boolean {
    return this.initialized && !this.closed && !this.failure
  }
  get hasCapacity(): boolean {
    return this.enabled && this.jobs.length + Number(Boolean(this.worker)) < 4
  }

  constructor(
    readonly directory: string,
    readonly policy: Readonly<CapturePolicy> = defaultCapturePolicy,
    private now = Date.now,
  ) {
    if (
      !["none", "html", "screenshot", "both"].includes(policy.mode) ||
      ![policy.artifactBytes, policy.totalBytes, policy.records, policy.retentionMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      policy.artifactBytes > 8 * 1024 * 1024 ||
      policy.totalBytes > 1024 * 1024 * 1024 ||
      policy.records > 5000 ||
      policy.retentionMs > INDEX_RETENTION_MS
    )
      throw new Error("Invalid capture storage limits")
    this.ready = this.initialize().catch(() => {
      this.failure = "Capture storage could not be initialized"
      this.db?.close()
      this.db = undefined
    })
  }

  private async initialize() {
    const path = join(this.directory, "index.sqlite")
    // A new metadata-only deployment creates no artifact directory or database.
    if (this.policy.mode === "none" && !existsSync(path)) {
      this.initialized = true
      return
    }
    const existing = existsSync(path)
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink())
      throw new Error("Capture directory cannot be a symlink")
    if (!existing && existsSync(this.directory)) {
      const directory = await opendir(this.directory)
      try {
        if (await directory.read()) throw new Error("Capture directory is already in use")
      } finally {
        await directory.close()
      }
    }
    if (existing && !lstatSync(path).isFile()) throw new Error("Capture index must be a regular file")
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const db = new Database(path, { create: true })
    this.db = db
    const marker = (db.query("PRAGMA application_id").get() as { application_id: number }).application_id
    if (existing && marker !== APPLICATION_ID) throw new Error("Capture index is not owned by TRAWL")
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    if (version < 0 || version > 1) throw new Error("Unsupported capture index version")
    chmodSync(this.directory, 0o700)
    chmodSync(path, 0o600)
    if (!existing) db.run(`PRAGMA application_id=${APPLICATION_ID}`)
    db.run("PRAGMA journal_mode=WAL")
    db.run("PRAGMA busy_timeout=1000")
    db.run("PRAGMA max_page_count=16384")
    db.run("PRAGMA journal_size_limit=1048576")
    db.run(`CREATE TABLE IF NOT EXISTS captures (
      request_id TEXT PRIMARY KEY, request_at TEXT NOT NULL, created INTEGER NOT NULL,
      mode TEXT NOT NULL, data TEXT NOT NULL, stored_bytes INTEGER NOT NULL DEFAULT 0,
      files INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0)`)
    db.run("CREATE INDEX IF NOT EXISTS captures_created ON captures(created)")
    db.run("PRAGMA user_version=1")
    this.used = (
      db.query("SELECT coalesce(sum(stored_bytes),0) AS bytes FROM captures").get() as { bytes: number }
    ).bytes
    this.rowCount = (db.query("SELECT count(*) AS count FROM captures").get() as { count: number }).count
    if (this.rowCount > INDEX_RECORDS) throw new Error("Capture index exceeds its record limit")
    const referenced = new Set<string>()
    const rows = db.query("SELECT * FROM captures WHERE files > 0 OR pending > 0 LIMIT 50001").all() as Row[]
    if (rows.length > INDEX_RECORDS) throw new Error("Capture index exceeds its record limit")
    for (const row of rows) {
      const manifest = this.decode(row)
      if (row.pending) await this.expire(row, "failed", "interrupted-write")
      else
        for (const artifact of manifest.artifacts)
          if (artifact.state === "ready") referenced.add(this.filename(row.request_id, artifact.kind))
    }
    const entries = await opendir(this.directory)
    let count = 0
    for await (const entry of entries) {
      if (++count > 10032) throw new Error("Capture directory exceeds its file limit")
      if (/^[A-Za-z0-9_-]{1,80}\.(html|screenshot)\.(capture|tmp)$/.test(entry.name) && !referenced.has(entry.name))
        await unlink(join(this.directory, entry.name)).catch(() => {})
    }
    await this.prune()
    this.initialized = true
    this.timer = setInterval(() => {
      this.pruneNeeded = true
      this.wake()
    }, 60000)
    this.timer.unref()
  }

  private filename(id: string, kind: ArtifactKind) {
    return `${id}.${kind}.capture`
  }
  private row(id: string): Row | undefined {
    return this.db?.query("SELECT * FROM captures WHERE request_id=?").get(id) as Row | undefined
  }
  private decode(row: Row): RequestCaptures {
    if (!validId(row.request_id) || row.data.length > 8192) throw new Error("Invalid capture index entry")
    const value = JSON.parse(row.data) as RequestCaptures
    if (
      value.requestId !== row.request_id ||
      value.requestAt !== row.request_at ||
      value.mode !== row.mode ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length > 2 ||
      value.artifacts.some(
        (artifact) =>
          !kinds.includes(artifact.kind) ||
          !["pending", "ready", "unavailable", "too-large", "expired", "failed"].includes(artifact.state),
      )
    )
      throw new Error("Invalid capture manifest")
    return value
  }
  private write(manifest: RequestCaptures, storedBytes: number, files: number, pending: boolean, created = this.now()) {
    const existing = this.row(manifest.requestId)
    if (!existing && this.rowCount >= INDEX_RECORDS) {
      const expendable = this.db
        ?.query("SELECT request_id FROM captures WHERE files=0 AND pending=0 ORDER BY created,request_id LIMIT 1")
        .get() as { request_id: string } | undefined
      if (!expendable) throw new Error("Capture index is full")
      this.db?.query("DELETE FROM captures WHERE request_id=?").run(expendable.request_id)
      this.rowCount--
    }
    this.db
      ?.query(`INSERT INTO captures VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET request_at=excluded.request_at, created=excluded.created,
      mode=excluded.mode,data=excluded.data,stored_bytes=excluded.stored_bytes,files=excluded.files,pending=excluded.pending`)
      .run(
        manifest.requestId,
        manifest.requestAt,
        created,
        manifest.mode,
        JSON.stringify(manifest),
        storedBytes,
        files,
        Number(pending),
      )
    if (!existing) this.rowCount++
  }

  manifest(requestId: string, requestAt: string): RequestCaptures {
    const empty: RequestCaptures = { requestId, requestAt, mode: "none", artifacts: [] }
    if (!validId(requestId) || this.closed || !this.initialized) return empty
    try {
      const row = this.row(requestId)
      const result = row && row.request_at === requestAt ? this.decode(row) : empty
      if (this.failure)
        for (const artifact of result.artifacts)
          if (artifact.state === "pending") {
            artifact.state = "failed"
            artifact.reason = "storage-unavailable"
          }
      return result
    } catch {
      return empty
    }
  }

  /** Copies admitted bytes; callers can release their result and screenshot buffers immediately. */
  capture(input: Input): void {
    if (
      this.closed ||
      !this.initialized ||
      !this.db ||
      this.failure ||
      this.policy.mode === "none" ||
      !validId(input.requestId)
    )
      return
    try {
      const old = this.row(input.requestId)
      if (old?.request_at === input.requestAt) return
      const includeHtml =
        this.policy.mode !== "screenshot" ||
        (this.policy.fallbackHtml && (!input.screenshot || input.screenshot.byteLength > this.policy.artifactBytes))
      const selected = kinds.filter((kind) => (kind === "html" ? includeHtml : this.policy.mode !== "html"))
      const manifest: RequestCaptures = {
        requestId: input.requestId,
        requestAt: input.requestAt,
        mode: this.policy.mode,
        artifacts: [],
      }
      const parts = new Map<ArtifactKind, Uint8Array>()
      let reservation = 0
      for (const kind of selected) {
        const raw = kind === "html" ? input.html : input.screenshot
        const artifact: RequestArtifact = {
          kind,
          state:
            kind === "screenshot" && input.screenshotReason === "artifact-byte-limit" ? "too-large" : "unavailable",
          reason: kind === "screenshot" ? (input.screenshotReason ?? "no-browser-screenshot") : "no-content",
        }
        if (raw !== undefined) {
          const length = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
          artifact.bytes = length
          if (length > this.policy.artifactBytes) {
            artifact.state = "too-large"
            artifact.reason = "artifact-byte-limit"
          } else {
            artifact.state = "pending"
            delete artifact.reason
            artifact.capturedAt = input.capturedAt ?? new Date(this.now()).toISOString()
            artifact.contentType =
              kind === "screenshot" ? "image/jpeg" : (input.contentType ?? "text/html; charset=utf-8").slice(0, 128)
            reservation += length
          }
        }
        manifest.artifacts.push(artifact)
        if (kind === "html" && input.htmlTruncated) artifact.truncated = true
      }
      const admitted =
        this.jobs.length + Number(Boolean(this.worker)) < 4 && this.reserved + reservation <= this.policy.totalBytes
      if (!admitted)
        for (const artifact of manifest.artifacts)
          if (artifact.state === "pending") {
            artifact.state = "failed"
            artifact.reason = "capture-queue-limit"
          }
      this.write(
        manifest,
        old?.stored_bytes ?? 0,
        old?.files ?? 0,
        admitted && manifest.artifacts.some((artifact) => artifact.state === "pending"),
      )
      if (!admitted) {
        this.pruneNeeded = true
        this.wake()
        return
      }
      for (const artifact of manifest.artifacts)
        if (artifact.state === "pending") {
          const raw = artifact.kind === "html" ? input.html : input.screenshot
          if (raw !== undefined)
            parts.set(artifact.kind, typeof raw === "string" ? Buffer.from(raw) : Uint8Array.from(raw))
        }
      this.reserved += reservation
      this.jobs.push({ manifest, parts, reservation })
      this.wake()
    } catch {
      this.failure = "Capture storage write failed"
    }
  }

  private wake() {
    if (this.worker || !this.db || this.closed) return
    this.worker = this.run()
      .catch(() => {
        this.failure = "Capture storage maintenance failed"
      })
      .finally(() => {
        if (this.failure) {
          this.jobs.length = 0
          this.reserved = 0
          this.pruneNeeded = false
          this.invalid.clear()
        }
        this.worker = undefined
        if (!this.closed && (this.jobs.length || this.pruneNeeded)) this.wake()
      })
  }
  private async run() {
    while (this.jobs.length || this.pruneNeeded) {
      const job = this.jobs.shift()
      this.pruneNeeded = false
      await this.prune()
      if (!job) continue
      try {
        await this.save(job)
      } catch {
        const row = this.row(job.manifest.requestId)
        if (row) await this.expire(row, "failed", "storage-write-failed")
      } finally {
        this.reserved -= job.reservation
      }
    }
  }
  private async save(job: Job) {
    const { manifest } = job
    const old = this.row(manifest.requestId)
    if (old?.files) await this.removeFiles(old)
    if (!job.parts.size) {
      this.write(manifest, 0, 0, false)
      return
    }
    while (this.used + this.reserved > this.policy.totalBytes || this.readyRecords() >= this.policy.records) {
      const oldest = this.db
        ?.query("SELECT * FROM captures WHERE files > 0 ORDER BY created,request_id LIMIT 1")
        .get() as Row | undefined
      if (!oldest) throw new Error("Capture quota unavailable")
      await this.expire(oldest, "expired", "storage-quota")
    }
    let storedBytes = 0
    let files = 0
    for (const artifact of manifest.artifacts) {
      const raw = job.parts.get(artifact.kind)
      if (!raw) continue
      let bytes = raw
      let encoding: "identity" | "gzip" = "identity"
      if (artifact.kind === "html") {
        const compressed = gzipSync(raw, { level: 1 })
        if (compressed.byteLength < raw.byteLength) {
          bytes = compressed
          encoding = "gzip"
        }
      }
      const temporary = join(this.directory, `${manifest.requestId}.${artifact.kind}.tmp`)
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, join(this.directory, this.filename(manifest.requestId, artifact.kind)))
      storedBytes += bytes.byteLength
      files++
      artifact.state = "ready"
      artifact.sha256 = hash(raw)
      artifact.storedBytes = bytes.byteLength
      artifact.encoding = encoding
      this.write(manifest, storedBytes, files, true)
      this.used += bytes.byteLength
    }
    this.write(manifest, storedBytes, files, false)
  }
  private readyRecords() {
    return (
      (this.db?.query("SELECT count(*) AS count FROM captures WHERE files > 0").get() as { count: number } | undefined)
        ?.count ?? 0
    )
  }
  private async removeFiles(row: Row) {
    for (const kind of kinds) {
      await unlink(join(this.directory, this.filename(row.request_id, kind))).catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
      await unlink(join(this.directory, `${row.request_id}.${kind}.tmp`)).catch((error) => {
        if (error.code !== "ENOENT") throw error
      })
    }
    this.used = Math.max(0, this.used - row.stored_bytes)
    this.db?.query("UPDATE captures SET files=0,stored_bytes=0 WHERE request_id=?").run(row.request_id)
  }
  private async expire(row: Row, state: "expired" | "failed", reason: string) {
    await this.removeFiles(row)
    const manifest = this.decode(row)
    for (const artifact of manifest.artifacts)
      if (artifact.state === "ready" || artifact.state === "pending") {
        artifact.state = state
        artifact.reason = reason
      }
    this.write(manifest, 0, 0, false, row.created)
  }
  private async prune() {
    if (!this.db) return
    for (const [id, requestAt] of this.invalid) {
      const row = this.row(id)
      if (row?.request_at === requestAt) await this.expire(row, "failed", "artifact-unavailable")
      this.invalid.delete(id)
    }
    const expired = this.db
      .query("SELECT * FROM captures WHERE files > 0 AND created < ? LIMIT 5001")
      .all(this.now() - this.policy.retentionMs) as Row[]
    for (const row of expired) await this.expire(row, "expired", "retention-age")
    const old = this.db
      .query(`SELECT * FROM captures WHERE created < ? OR request_id IN (
      SELECT request_id FROM captures ORDER BY created DESC,request_id DESC LIMIT -1 OFFSET ?)`)
      .all(this.now() - INDEX_RETENTION_MS, INDEX_RECORDS) as Row[]
    for (const row of old) {
      await this.removeFiles(row)
      this.db.query("DELETE FROM captures WHERE request_id=?").run(row.request_id)
      this.rowCount--
    }
    while (this.used > this.policy.totalBytes || this.readyRecords() > this.policy.records) {
      const row = this.db.query("SELECT * FROM captures WHERE files > 0 ORDER BY created,request_id LIMIT 1").get() as
        | Row
        | undefined
      if (!row) break
      await this.expire(row, "expired", "storage-quota")
    }
  }

  async read(requestId: string, requestAt: string, kind: ArtifactKind): Promise<Uint8Array | undefined> {
    if (!validId(requestId) || !kinds.includes(kind) || this.readers >= 4 || this.closed) return
    const manifest = this.manifest(requestId, requestAt)
    const artifact = manifest.artifacts.find((value) => value.kind === kind && value.state === "ready")
    if (
      !artifact ||
      artifact.bytes === undefined ||
      artifact.storedBytes === undefined ||
      artifact.bytes > this.policy.artifactBytes ||
      artifact.storedBytes > this.policy.artifactBytes
    )
      return
    this.readers++
    try {
      const handle = await open(
        join(this.directory, this.filename(requestId, kind)),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      )
      let bytes: Uint8Array
      try {
        const size = (await handle.stat()).size
        if (size !== artifact.storedBytes) throw new Error("Artifact size changed")
        const buffer = Buffer.alloc(size + 1)
        let length = 0
        while (length < buffer.length) {
          const part = await handle.read(buffer, length, buffer.length - length, null)
          if (!part.bytesRead) break
          length += part.bytesRead
        }
        if (length !== size) throw new Error("Artifact length changed")
        bytes = buffer.subarray(0, size)
      } finally {
        await handle.close()
      }
      const raw = artifact.encoding === "gzip" ? gunzipSync(bytes, { maxOutputLength: artifact.bytes + 1 }) : bytes
      if (raw.byteLength === artifact.bytes && hash(raw) === artifact.sha256) return raw
    } catch {
      /* Missing, corrupted or expired artifacts never change the scrape outcome. */
    } finally {
      this.readers--
    }
    if (!this.closed) {
      this.invalid.set(requestId, requestAt)
      this.pruneNeeded = true
      this.wake()
    }
  }
  async flush() {
    await this.ready
    while (this.worker) await this.worker
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.ready
    if (this.timer) clearInterval(this.timer)
    await this.flush()
    this.jobs.length = 0
    this.reserved = 0
    this.db?.close()
    this.db = undefined
  }
}
