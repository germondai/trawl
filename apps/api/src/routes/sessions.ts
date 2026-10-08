import { PoolExhaustedError } from "@trawl/browser"
import { normalizeProxy, RequestValidationError, validateSessionId } from "@trawl/tiers"
import type { CreateBrowserSession } from "@trawl/types"
import { Elysia } from "elysia"
import { getDeps, getPool } from "../deps"

export function sessionsRoute(deps = getDeps, poolReady: () => unknown = getPool) {
  const sessions = () => {
    if (!poolReady()) throw new RequestValidationError("Browser pool initializing", 503)
    const manager = deps().sessions
    if (!manager) throw new RequestValidationError("Browser sessions are unavailable", 503)
    return manager
  }
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof RequestValidationError || error instanceof PoolExhaustedError) {
        set.status = error instanceof RequestValidationError ? error.statusCode : 429
        return { error: error.message }
      }
    })
    .post("/sessions", async ({ body, set }) => {
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new RequestValidationError("Request body must be a JSON object", 400)
      const input = body as CreateBrowserSession
      if (input.id !== undefined) validateSessionId(input.id)
      for (const field of ["headful", "ignoreCertificateErrors"] as const) {
        if (input[field] !== undefined && typeof input[field] !== "boolean")
          throw new RequestValidationError(`${field} must be a boolean`, 400)
      }
      if (input.proxy !== undefined && typeof input.proxy !== "string")
        throw new RequestValidationError("proxy must be a URL string", 400)
      if (input.proxy !== undefined && !input.proxy.trim())
        throw new RequestValidationError("proxy must not be empty", 400)
      const result = await sessions().create({
        id: input.id,
        proxy: normalizeProxy(input.proxy),
        headful: input.headful,
        ignoreCertificateErrors: input.ignoreCertificateErrors,
      })
      set.status = 201
      return result
    })
    .get("/sessions", async () => ({ sessions: await sessions().list() }))
    .delete("/sessions/:id", async ({ params }) => {
      await sessions().destroy(params.id)
      return { status: "ok" }
    })
}
