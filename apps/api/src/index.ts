import { Elysia } from "elysia"
import { POOL_SIZE, PORT } from "./config"
import { initPool } from "./deps"
import { registerLifecycleHandlers } from "./lifecycle"
import { healthRoute } from "./routes/health"
import { indexRoute } from "./routes/index"
import { scrapeRoute } from "./routes/scrape"
import { statsRoute } from "./routes/stats"
import { v1Route } from "./routes/v1"

new Elysia().use(indexRoute()).use(healthRoute()).use(statsRoute()).use(v1Route()).use(scrapeRoute()).listen(PORT)

console.log(`[api] TRAWL starting on :${PORT}  (pool: ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"})`)
initPool().catch((err) => {
  console.error("[api] startup failed:", err)
  process.exit(1)
})

registerLifecycleHandlers()
