import type { ApplicationLog, ArtifactKind, InstanceCapabilities } from "@trawl/types"
import { Elysia } from "elysia"
import { applicationLogs } from "../applicationLogs"
import { validBearer } from "../bearer"
import { browserObservations } from "../browserInspectorState"
import { BrowserObservationError, type BrowserObservations } from "../browserObservation"
import type { CaptureStore } from "../captureStore"
import { captures } from "../captures"
import { HEADFUL_POOL_SIZE, METRICS_DASHBOARD_TOKEN, OBSERVABILITY_ENABLED } from "../config"
import type { EventJournal } from "../eventJournal"
import { parseHistoryQuery } from "../historyQuery"
import { readInstanceSettings } from "../instanceSettings"
import { type MetricsStore, metrics } from "../metrics"

export function observabilityRoute({
  enabled = OBSERVABILITY_ENABLED,
  secret = METRICS_DASHBOARD_TOKEN,
  store = metrics,
  logs = applicationLogs,
  captureStore = captures,
  observations = browserObservations,
}: {
  enabled?: boolean
  secret?: string
  store?: MetricsStore
  logs?: EventJournal<ApplicationLog>
  captureStore?: CaptureStore
  observations?: BrowserObservations
} = {}) {
  const available = Boolean(enabled && secret && secret.length >= 32)
  let artifactTransfers = 0
  const app = new Elysia().get("/capabilities", ({ set }) => {
    set.headers["Cache-Control"] = "no-store"
    return {
      version: 1,
      authentication: "bearer",
      settings: available,
      requests: available,
      requestEvents: available,
      requestQuery: available,
      logs: available,
      logEvents: available,
      captures: available && Boolean(captureStore?.available),
      browserInspection: available && Boolean(observations),
      clientRequestIds: available && store.clientRequestIds,
      requestOptions: { binaryBodies: true, targetAuth: true },
    } satisfies InstanceCapabilities
  })
  if (!available) return app
  return app.guard(
    {
      beforeHandle({ request, set }) {
        set.headers["Cache-Control"] = "no-store"
        set.headers["X-Content-Type-Options"] = "nosniff"
        if (!validBearer(request.headers.get("authorization"), secret ?? "")) {
          set.status = 401
          set.headers["WWW-Authenticate"] = "Bearer"
          return { error: "Unauthorized" }
        }
      },
    },
    (app) =>
      app
        .get("/settings", () => readInstanceSettings())
        .get("/browser/pages", ({ set }) => {
          if (!observations) {
            set.status = 404
            return { error: "Browser inspection is not enabled" }
          }
          return observations.snapshot(HEADFUL_POOL_SIZE > 0)
        })
        .get("/browser/pages/:id/preview", async ({ params, set, request, server }) => {
          if (!observations) {
            set.status = 404
            return { error: "Browser inspection is not enabled" }
          }
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(params.id)) {
            set.status = 400
            return { error: "Invalid browser page ID" }
          }
          if (artifactTransfers >= 4) {
            set.status = 429
            set.headers["Retry-After"] = "1"
            return { error: "Too many image transfers" }
          }
          artifactTransfers++
          let handedOff = false
          try {
            const bytes = await observations.preview(params.id)
            server?.timeout(request, 20)
            const response = artifactResponse(
              bytes,
              request.signal,
              () => {
                artifactTransfers--
              },
              "screenshot",
            )
            handedOff = true
            return response
          } catch (cause) {
            set.status = cause instanceof BrowserObservationError ? cause.status : 503
            if (set.status === 429) set.headers["Retry-After"] = "1"
            return {
              error: cause instanceof BrowserObservationError ? cause.message : "Browser preview is unavailable",
            }
          } finally {
            if (!handedOff) artifactTransfers--
          }
        })
        .get("/requests", ({ request, set }) => {
          const query = new URL(request.url).searchParams
          const limit = query.get("limit") ?? "50"
          const before = query.get("before") ?? undefined
          if (!/^(?:[1-9][0-9]?|100)$/.test(limit) || (before !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(before))) {
            set.status = 400
            return { error: "Expected limit from 1 to 100 and a valid history cursor" }
          }
          let filters: ReturnType<typeof parseHistoryQuery>
          try {
            filters = parseHistoryQuery(query)
          } catch {
            set.status = 400
            return { error: "Invalid history filters" }
          }
          try {
            return store.history(Number(limit), before, filters)
          } catch {
            set.status = 409
            return { error: "History cursor expired; reload the first page" }
          }
        })
        .get("/requests/events", ({ request, server }) => {
          server?.timeout(request, 30)
          return store.events.stream(request)
        })
        .get("/requests/:id/captures", ({ params, set }) => {
          if (!/^[a-zA-Z0-9_-]{1,80}$/.test(params.id)) {
            set.status = 400
            return { error: "Invalid request ID" }
          }
          const entry = store.request(params.id)
          if (!entry) {
            set.status = 404
            return { error: "Request is not retained" }
          }
          if (!captureStore?.available) {
            set.status = 503
            return { error: "Capture storage is unavailable" }
          }
          return captureStore.manifest(entry.id, entry.at)
        })
        .get("/requests/:id/captures/:kind", async ({ params, set, request, server }) => {
          if (!/^[a-zA-Z0-9_-]{1,80}$/.test(params.id) || !["html", "screenshot", "request"].includes(params.kind)) {
            set.status = 400
            return { error: "Invalid artifact resource" }
          }
          const entry = store.request(params.id)
          if (!entry) {
            set.status = 404
            return { error: "Request is not retained" }
          }
          if (!captureStore?.available) {
            set.status = 503
            return { error: "Capture storage is unavailable" }
          }
          if (artifactTransfers >= 4) {
            set.status = 429
            set.headers["Retry-After"] = "1"
            return { error: "Too many artifact transfers" }
          }
          artifactTransfers++
          let handedOff = false
          try {
            const bytes = await captureStore.read(entry.id, entry.at, params.kind as ArtifactKind)
            if (!bytes) {
              set.status = 404
              return { error: "Saved content is unavailable or expired" }
            }
            server?.timeout(request, 20)
            const response = artifactResponse(
              bytes,
              request.signal,
              () => {
                artifactTransfers--
              },
              params.kind as ArtifactKind,
            )
            handedOff = true
            return response
          } finally {
            if (!handedOff) artifactTransfers--
          }
        })
        .get("/requests/:id", ({ params, set }) => {
          if (!/^[a-zA-Z0-9_-]{1,80}$/.test(params.id)) {
            set.status = 400
            return { error: "Invalid request ID" }
          }
          const entry = store.request(params.id)
          if (entry) return entry
          set.status = 404
          return { error: "Request is not retained" }
        })
        .get("/logs", ({ request, set }) => {
          const limit = new URL(request.url).searchParams.get("limit") ?? "100"
          if (!/^(?:[1-9][0-9]?|[1-4][0-9]{2}|500)$/.test(limit)) {
            set.status = 400
            return { error: "Expected limit from 1 to 500" }
          }
          return { ...logs.snapshot(Number(limit)), coverage: "structured-application-logs-since-start" }
        })
        .get("/logs/events", ({ request, server }) => {
          server?.timeout(request, 30)
          return logs.stream(request)
        }),
  )
}

function artifactResponse(bytes: Uint8Array, signal: AbortSignal, release: () => void, kind: ArtifactKind): Response {
  let closed = false
  let offset = 0
  let controller: ReadableStreamDefaultController<Uint8Array>
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    release()
  }
  const abort = () => {
    if (closed) return
    controller.error(new Error("Artifact transfer ended"))
    finish()
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
        timer = setTimeout(abort, 15000)
        timer.unref()
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      },
      pull(value) {
        if (closed) return
        const next = bytes.subarray(offset, offset + 65536)
        offset += next.byteLength
        value.enqueue(next)
        if (offset === bytes.byteLength) {
          value.close()
          finish()
        }
      },
      cancel() {
        finish()
      },
    },
    { highWaterMark: 1 },
  )
  return new Response(body, {
    headers: {
      "Content-Type":
        kind === "request" ? "application/json" : kind === "html" ? "text/plain; charset=utf-8" : "image/jpeg",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `attachment; filename="request.${kind === "request" ? "json" : kind === "html" ? "html" : "jpg"}"`,
    },
  })
}
