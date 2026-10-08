import { afterEach, expect, test } from "bun:test"
import { FINGERPRINT } from "@trawl/browser"
import { BrowserSessions, type OrchestratorDeps } from "@trawl/tiers"
import { Elysia } from "elysia"
import { MetricsStore } from "../metrics"
import { sessionsRoute } from "./sessions"
import { v1Route } from "./v1"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})
function app() {
  const sessions = new BrowserSessions({
    acquireBrowser: async () => ({
      id: 0,
      lease: 1,
      headful: false,
      fingerprint: FINGERPRINT,
      context: {},
      browser: { newContext: async () => ({ addInitScript: async () => {}, close: async () => {}, pages: () => [] }) },
    }),
    releaseBrowser: () => {},
    maxSessions: 2,
  })
  const metrics = new MetricsStore()
  cleanup.push(async () => {
    await sessions.shutdown()
    metrics.close()
  })
  const deps = () => ({ sessions }) as OrchestratorDeps
  const api = new Elysia()
    .use(sessionsRoute(deps, () => true))
    .use(v1Route({ poolReady: () => true, orchestratorDeps: deps, metricsStore: metrics }))
  return {
    send: async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const response = await api.handle(
        new Request(`http://localhost${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        }),
      )
      return { status: response.status, body: await response.json() }
    },
    metrics,
  }
}

test("native and FlareSolverr lifecycle commands share sessions without adding scrape metrics", async () => {
  const { send, metrics } = app()
  expect(await send("/sessions", { id: "native" })).toMatchObject({ status: 201, body: { id: "native", busy: false } })
  expect(await send("/v1", { cmd: "sessions.list" })).toMatchObject({ status: 200, body: { sessions: ["native"] } })
  expect(await send("/v1", { cmd: "sessions.create", session: "compat" })).toMatchObject({
    status: 200,
    body: { session: "compat" },
  })
  expect(await send("/sessions")).toMatchObject({
    status: 200,
    body: { sessions: [{ id: "native" }, { id: "compat" }] },
  })
  expect(await send("/v1", { cmd: "sessions.destroy", session: "native" })).toMatchObject({
    status: 200,
    body: { status: "ok" },
  })
  expect(await send("/sessions/compat", undefined, "DELETE")).toMatchObject({ status: 200, body: { status: "ok" } })
  expect(await send("/sessions")).toMatchObject({ body: { sessions: [] } })
  expect(metrics.snapshot().requests).toBe(0)
})

test("invalid session input, duplicates, missing IDs and capacity return actionable errors", async () => {
  const { send } = app()
  for (const body of [
    [],
    null,
    { id: "" },
    { id: "../private" },
    { headful: "yes" },
    { ignoreCertificateErrors: 1 },
    { proxy: {} },
    { proxy: "" },
    { proxy: "file:///tmp/local" },
  ]) {
    expect((await send("/sessions", body)).status).toBe(400)
  }
  expect((await send("/v1", { cmd: "sessions.destroy" })).status).toBe(400)
  expect((await send("/sessions/absent", undefined, "DELETE")).status).toBe(404)
  await send("/sessions", { id: "a" })
  expect((await send("/sessions", { id: "a" })).status).toBe(409)
  await send("/sessions", { id: "b" })
  expect((await send("/sessions", { id: "c" })).status).toBe(429)
})

test("session management errors do not pollute scrape request history", async () => {
  const { send, metrics } = app()
  await send("/v1", { cmd: "sessions.create", session: "a" })
  expect((await send("/v1", { cmd: "sessions.create", session: "a" })).status).toBe(200)
  expect((await send("/v1", { cmd: "sessions.destroy", session: "missing" })).status).toBe(404)
  expect((await send("/v1", { cmd: "sessions.destroy" })).status).toBe(400)
  expect(metrics.snapshot().requests).toBe(0)
})
