import { Elysia } from "elysia"
import { HOST, MCP_ENABLED } from "./config"
import { allowLocalRequest } from "./localAccess"
import { dashboardRoute } from "./routes/dashboard"
import { healthRoute } from "./routes/health"
import { indexRoute } from "./routes/index"
import { mcpRoute } from "./routes/mcp"
import { metricsRoute } from "./routes/metrics"
import { observabilityRoute } from "./routes/observability"
import { proxyCaRoute } from "./routes/proxy-ca"
import { scrapeRoute } from "./routes/scrape"
import { sessionsRoute } from "./routes/sessions"
import { statsRoute } from "./routes/stats"
import { v1Route } from "./routes/v1"

export function createApiApp({
  mcpEnabled = MCP_ENABLED,
  localManaged = process.env.TRAWL_MANAGED_INSTANCE === "1",
}: {
  mcpEnabled?: boolean
  localManaged?: boolean
} = {}) {
  const app = new Elysia()
    .onRequest(({ request, set }) => {
      if (localManaged && !allowLocalRequest(request, HOST)) {
        set.status = 403
        return { error: "Cross-origin access to a managed instance is not allowed" }
      }
    })
    .use(indexRoute())
    .use(healthRoute())
    .use(statsRoute())
    .use(metricsRoute())
    .use(dashboardRoute())
    .use(observabilityRoute())
    .use(v1Route())
    .use(scrapeRoute())
    .use(sessionsRoute())
    .use(proxyCaRoute())

  if (mcpEnabled) app.use(mcpRoute())
  return app
}
