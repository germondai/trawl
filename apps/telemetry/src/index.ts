import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createCollector } from "./collector"

const database = process.env.TELEMETRY_DB_PATH || "./data/usage.sqlite"
mkdirSync(dirname(database), { recursive: true, mode: 0o700 })
const collector = createCollector({ database, adminToken: process.env.TELEMETRY_ADMIN_TOKEN ?? "" })
const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 8198),
  maxRequestBodySize: 16384,
  idleTimeout: 5,
  fetch: (request, server) => collector.handle(request, server.requestIP(request)?.address),
  error: () => Response.json({ error: "Request failed" }, { status: 500 }),
})
console.log(`TRAWL usage collector listening on ${server.hostname}:${server.port}`)
const close = () => {
  server.stop(true)
  collector.close()
  process.exit(0)
}
process.on("SIGTERM", close)
process.on("SIGINT", close)
