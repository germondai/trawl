import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestratorDeps } from "@trawl/tiers"
import { Elysia } from "elysia"
import { Trawl } from "../../../packages/client/src/index"
import { MetricsStore } from "./metrics"
import { observabilityRoute } from "./routes/observability"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

test("native HTTP, JSON POST and /v1 share durable history and independent live request IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-observability-"))
  const database = join(directory, "requests.sqlite")
  const secret = "owned-fixture-token-abcdefghijklmnopqrstuvwxyz"
  const store = new MetricsStore(true, database, true)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let browserLaunches = 0
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => {
      browserLaunches++
      throw new Error("HTTP fixture must not launch a browser")
    },
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/slow") await gate
      if (request.method === "POST") return Response.json({ received: await request.json() })
      return new Response(
        `<html><head><title>Owned fixture</title></head><body>${"Ordinary content. ".repeat(30)}</body></html>`,
        {
          headers: { "content-type": "text/html" },
        },
      )
    },
  })
  const app = new Elysia()
    .use(observabilityRoute({ enabled: true, secret, store }))
    .use(
      scrapeRoute(
        () => deps,
        () => true,
        store,
      ),
    )
    .use(v1Route({ poolReady: () => true, orchestratorDeps: () => deps, metricsStore: store }))
    .listen({ hostname: "127.0.0.1", port: 0, idleTimeout: 1 })
  if (!app.server) throw new Error("Fixture server failed to start")
  const baseURL = `http://127.0.0.1:${app.server.port}`
  const client = new Trawl({ baseURL, apiKey: secret, timeoutMs: 4_000 })
  const abort = new AbortController()
  const initial = await client.requests.list()
  const events = client.requests.events({ cursor: initial.cursor, signal: abort.signal })
  try {
    expect((await events.next()).value?.type).toBe("ready")
    // The SSE route overrides a shorter server-wide idle timeout without changing other routes.
    await Bun.sleep(1_100)
    const pending = client.scrape({ url: new URL("/slow", target.url).href, maxTier: 1, detectWaf: false })
    const started = (await events.next()).value
    if (started?.type !== "entry" || started.data.type !== "started") throw new Error("Missing request start")
    const id = started.data.request.id
    expect((await client.requests.list()).active.map(({ id }) => id)).toEqual([id])
    release()
    const result = await pending
    expect(result.requestId).toBe(id)
    expect(result.html).toContain("Owned fixture")
    const finished = (await events.next()).value
    if (finished?.type !== "entry") throw new Error("Missing request completion")
    expect(finished.data).toMatchObject({
      type: "completed",
      persisted: true,
      request: { id, source: "native", method: "GET" },
    })
    const post = await client.scrape({
      url: target.url.href,
      method: "POST",
      body: { hello: "native" },
      maxTier: 1,
      detectWaf: false,
    })
    expect(JSON.parse(post.html)).toEqual({ received: { hello: "native" } })
    const v1 = await fetch(`${baseURL}/v1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cmd: "request.post",
        url: target.url.href,
        postData: '{"hello":"prowlarr"}',
        headers: { "content-type": "application/json" },
        maxTimeout: 4_000,
      }),
    })
    const legacy = await v1.json()
    expect(legacy.status).toBe("ok")
    expect(JSON.parse(legacy.solution.response)).toEqual({ received: { hello: "prowlarr" } })
    const history = await client.requests.list()
    expect(history.entries).toHaveLength(3)
    expect(new Set(history.entries.map(({ id }) => id)).size).toBe(3)
    expect(history.entries[0]).toMatchObject({ source: "flaresolverr", method: "POST" })
    expect(history.active).toEqual([])
    expect(browserLaunches).toBe(0)
    expect((await client.requests.get(id)).id).toBe(id)
  } finally {
    release()
    abort.abort()
    await events.return(undefined).catch(() => {})
    for (let index = 0; index < 30 && store.events.subscribers; index++) await Bun.sleep(5)
    expect(store.events.subscribers).toBe(0)
    app.stop(true)
    target.stop(true)
    const ids = store.history().entries.map(({ id }) => id)
    store.close()
    const reopened = new MetricsStore(true, database, true)
    expect(reopened.history().entries.map(({ id }) => id)).toEqual(ids)
    expect(reopened.events.cursor).not.toBe(initial.cursor)
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)
