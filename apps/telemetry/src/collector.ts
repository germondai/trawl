import { Database } from "bun:sqlite"
import { timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, lstatSync } from "node:fs"
import { usageBatch } from "@trawl/telemetry"

/** Stores hourly aggregates only. No request bodies, client identities or IPs enter SQLite. */
export function createCollector(options: { database: string; adminToken: string; now?: () => number }) {
  if (options.adminToken.length < 32) throw new Error("TELEMETRY_ADMIN_TOKEN requires at least 32 characters")
  const now = options.now ?? Date.now
  const existing = options.database !== ":memory:" && existsSync(options.database)
  if (
    existing &&
    (!lstatSync(options.database).isFile() ||
      lstatSync(options.database).isSymbolicLink() ||
      lstatSync(options.database).size > 64 * 1024 ** 2)
  )
    throw new Error("Invalid collector database")
  const db = new Database(options.database, { create: true })
  const applicationId = 0x54525553
  if (
    existing &&
    (db.query("PRAGMA application_id").get() as { application_id: number }).application_id !== applicationId
  ) {
    db.close()
    throw new Error("Database belongs to another application")
  }
  db.run(`PRAGMA application_id=${applicationId}`)
  if (options.database !== ":memory:" && process.platform !== "win32") chmodSync(options.database, 0o600)
  db.run("PRAGMA max_page_count=8192")
  db.run("PRAGMA journal_size_limit=1048576")
  db.run("PRAGMA secure_delete=ON")
  db.run(
    "CREATE TABLE IF NOT EXISTS usage (hour INTEGER,domain TEXT,challenge TEXT,success INTEGER,duration_bucket INTEGER,version TEXT,requests INTEGER,duration_ms INTEGER, PRIMARY KEY(hour,domain,challenge,success,duration_bucket,version))",
  )
  const peers = new Map<string, { at: number; count: number }>()
  let lastPrune = 0
  function prune() {
    const at = now()
    if (at - lastPrune < 60000) return
    for (const [key, item] of peers) if (at - item.at >= 60000) peers.delete(key)
    db.query("DELETE FROM usage WHERE hour < ?").run(Math.ceil((at - 30 * 86400000) / 3600000))
    lastPrune = at
  }
  prune()
  const maintenance = setInterval(() => {
    try {
      prune()
    } catch {
      /* Ingestion reports unavailable storage. */
    }
  }, 60000)
  maintenance.unref?.()
  const ingest = db.transaction((events: NonNullable<ReturnType<typeof usageBatch>>, hour: number) => {
    for (const event of events) {
      const bucket =
        event.durationMs < 1000 ? 1000 : event.durationMs < 5000 ? 5000 : event.durationMs < 30000 ? 30000 : 600000
      db.query(
        "INSERT INTO usage VALUES (?,?,?,?,?,?,1,?) ON CONFLICT(hour,domain,challenge,success,duration_bucket,version) DO UPDATE SET requests=requests+1,duration_ms=duration_ms+excluded.duration_ms",
      ).run(hour, event.domain, event.challenge, Number(event.success), bucket, event.version, event.durationMs)
    }
  })
  return {
    async handle(request: Request, peer = "unknown"): Promise<Response> {
      const path = new URL(request.url).pathname
      const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }
      const reply = (status: number, value: unknown) => Response.json(value, { status, headers })
      if (path === "/health" && request.method === "GET") return reply(200, { status: "ok" })
      if (path === "/v1/stats" && request.method === "GET") {
        const supplied = Buffer.from(request.headers.get("authorization") ?? "")
        const expected = Buffer.from(`Bearer ${options.adminToken}`)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          return reply(401, { error: "Unauthorized" })
        prune()
        return reply(200, { rows: db.query("SELECT * FROM usage ORDER BY hour DESC LIMIT 1000").all() })
      }
      if (path !== "/v1/events" || request.method !== "POST") return reply(404, { error: "Not found" })
      const at = now()
      prune()
      const limit = peers.get(peer)
      if (limit && at - limit.at < 60000) {
        if (++limit.count > 120) return reply(429, { error: "Rate limit" })
      } else {
        if (peers.size >= 1024) return reply(429, { error: "Busy" })
        peers.set(peer, { at, count: 1 })
      }
      if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
        return reply(415, { error: "JSON required" })
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = request.body?.getReader()
      if (!reader) return reply(400, { error: "Missing body" })
      const deadline = AbortSignal.timeout(3000)
      const cancel = () => {
        void reader.cancel().catch(() => {})
      }
      deadline.addEventListener("abort", cancel, { once: true })
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 16384) {
            await reader.cancel()
            return reply(413, { error: "Batch too large" })
          }
          chunks.push(part.value)
        }
        if (deadline.aborted) return reply(408, { error: "Request timed out" })
        let raw: unknown
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          return reply(400, { error: "Invalid JSON" })
        }
        const events = usageBatch(raw)
        if (!events) return reply(400, { error: "Invalid batch" })
        try {
          ingest(events, Math.floor(at / 3600000))
        } catch {
          return reply(503, { error: "Storage unavailable" })
        }
        return reply(202, { accepted: events.length })
      } finally {
        deadline.removeEventListener("abort", cancel)
        reader.releaseLock()
      }
    },
    close() {
      clearInterval(maintenance)
      peers.clear()
      db.close()
    },
  }
}
