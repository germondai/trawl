import { Elysia } from "elysia"
import { validBearer } from "../bearer"
import { METRICS_DASHBOARD_ENABLED, METRICS_DASHBOARD_TOKEN } from "../config"
import { type MetricsStore, metricRanges, metrics } from "../metrics"
import { dashboardPage } from "./dashboardPage"

export function dashboardRoute(
  secret = METRICS_DASHBOARD_TOKEN,
  store: MetricsStore = metrics,
  enabled = METRICS_DASHBOARD_ENABLED,
) {
  const app = new Elysia()
  if (!secret && !enabled) return app
  const authorized = (header: string | null) => !secret || validBearer(header, secret)
  let subscribers = 0
  return app
    .get("/dashboard", ({ set }) => {
      set.headers["Content-Type"] = "text/html; charset=utf-8"
      set.headers["Cache-Control"] = "no-store"
      set.headers["Content-Security-Policy"] =
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
      return dashboardPage(Boolean(secret))
    })
    .get("/dashboard/metrics", ({ request, set }) => {
      set.headers["Cache-Control"] = "no-store"
      if (!authorized(request.headers.get("authorization"))) {
        set.status = 401
        return { error: "Unauthorized" }
      }
      const value = Number(new URL(request.url).searchParams.get("minutes") || 60)
      return store.snapshot(
        metricRanges.includes(value as (typeof metricRanges)[number]) ? (value as (typeof metricRanges)[number]) : 60,
      )
    })
    .get("/dashboard/events", ({ request, set, server }) => {
      if (!authorized(request.headers.get("authorization"))) {
        set.status = 401
        return { error: "Unauthorized" }
      }
      if (subscribers >= 16) return new Response("Too many stream subscribers", { status: 429 })
      server?.timeout(request, 30)
      subscribers++
      let cleanup = () => {}
      let flush = () => {}
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          let dirty = false
          let closed = false
          flush = () => {
            if (!closed && dirty && (controller.desiredSize ?? 0) > 0) {
              dirty = false
              controller.enqueue(encoder.encode("event: update\ndata: {}\n\n"))
            }
          }
          const send = () => {
            dirty = true
            flush()
          }
          controller.enqueue(encoder.encode(": connected\n\n"))
          const unsubscribe = store.subscribe(send)
          const heartbeat = setInterval(() => {
            if (!closed && (controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": heartbeat\n\n"))
          }, 20_000)
          heartbeat.unref?.()
          const close = () => {
            if (closed) return
            closed = true
            subscribers--
            clearInterval(heartbeat)
            unsubscribe()
            request.signal.removeEventListener("abort", close)
            try {
              controller.close()
            } catch {
              /* Already closed. */
            }
          }
          cleanup = close
          request.signal.addEventListener("abort", close, { once: true })
          if (request.signal.aborted) close()
        },
        pull() {
          flush()
        },
        cancel() {
          cleanup()
        },
      })
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      })
    })
}
