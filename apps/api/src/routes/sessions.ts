import { PoolExhaustedError } from "@trawl/browser"
import { normalizeProxy, RequestBudget, RequestValidationError, validateSessionId } from "@trawl/tiers"
import type { CreateBrowserSession, SessionEvalRequest } from "@trawl/types"
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
      set.status = 500
      return { error: error instanceof Error ? error.message : String(error) }
    })
    .post("/sessions", async ({ body, set }) => {
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new RequestValidationError("Request body must be a JSON object", 400)
      const input = body as CreateBrowserSession
      if (input.id !== undefined) validateSessionId(input.id)
      for (const field of ["headful", "ignoreCertificateErrors", "keepPage", "publicOnly"] as const) {
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
        keepPage: input.keepPage,
        publicOnly: input.publicOnly,
      })
      set.status = 201
      return result
    })
    .get("/sessions", async () => ({ sessions: await sessions().list() }))
    .post("/sessions/:id/eval", async ({ params, body }) => {
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new RequestValidationError("Request body must be a JSON object", 400)
      const input = body as SessionEvalRequest
      if (typeof input.expression !== "string" || !input.expression.trim())
        throw new RequestValidationError("expression must be a non-empty string", 400)
      if (
        input.maxTimeout !== undefined &&
        (typeof input.maxTimeout !== "number" || !Number.isFinite(input.maxTimeout) || input.maxTimeout < 1)
      )
        throw new RequestValidationError("maxTimeout must be a positive number", 400)
      const budget = new RequestBudget(input.maxTimeout ?? deps().defaultMaxTimeout ?? 60_000)
      try {
        return { value: await sessions().evaluate(params.id, input.expression, budget) }
      } finally {
        budget.dispose()
      }
    })
    .get("/sessions/:id/cookies", async ({ params }) => {
      const budget = new RequestBudget(deps().defaultMaxTimeout ?? 60_000)
      try {
        return { cookies: await sessions().cookies(params.id, budget) }
      } finally {
        budget.dispose()
      }
    })
    .delete("/sessions/:id", async ({ params }) => {
      await sessions().destroy(params.id)
      return { status: "ok" }
    })
}
