import { expect, test } from "bun:test"
import type { OrchestratorDeps } from "@trawl/tiers"
import { Elysia } from "elysia"
import { Trawl } from "../../../packages/client/src/index"
import { newWorkbenchDraft, sendWorkbench } from "../../desktop/app/utils/workbench"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"

test("desktop workbench GET and JSON POST execute through the real native scraping handler", async () => {
  let calls = 0
  let launches = 0
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const accepted = new Promise<void>((resolve) => {
    entered = resolve
  })
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++
      if (calls === 1) {
        entered()
        await gate
      }
      if (new URL(request.url).pathname === "/binary")
        return Response.json({
          body: Buffer.from(await request.arrayBuffer()).toString("base64"),
          auth: request.headers.get("Authorization"),
        })
      if (new URL(request.url).pathname === "/multipart") {
        const form = await request.formData()
        const file = form.get("upload") as File
        return Response.json({
          body: Buffer.from(await file.arrayBuffer()).toString("base64"),
          name: file.name,
          text: form.get("text"),
        })
      }
      if (request.method === "POST") return Response.json({ received: await request.json() })
      return new Response(
        `<html><head><title>Workbench fixture</title></head><body>${"Owned fixture content. ".repeat(30)}</body></html>`,
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => {
      launches++
      throw new Error("Unexpected browser launch")
    },
    releaseBrowser: () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  const store = new MetricsStore(true, ":memory:", true)
  const app = new Elysia()
    .use(
      scrapeRoute(
        () => deps,
        () => true,
        store,
      ),
    )
    .listen({ hostname: "127.0.0.1", port: 0 })
  if (!app.server) throw new Error("Fixture failed to start")
  try {
    const proposedId = "10000000-0000-4000-8000-000000000000"
    const api = new Trawl({
      baseURL: `http://127.0.0.1:${app.server.port}`,
      headers: { "X-Trawl-Request-ID": proposedId },
    })
    const draft = { ...newWorkbenchDraft(), url: target.url.href, maxTier: 1 as const, options: '{"detectWaf":false}' }
    const waiting = sendWorkbench(api, draft, new AbortController().signal)
    await accepted
    expect(store.history().active[0]?.id).toBe(proposedId)
    release()
    const first = await waiting
    expect("html" in first && first.html).toContain("Workbench fixture")
    expect(first.requestId).toBe(proposedId)
    const second = await sendWorkbench(
      api,
      { ...draft, method: "POST", bodyMode: "json", body: '{"hello":"world"}' },
      new AbortController().signal,
    )
    expect("html" in second && JSON.parse(second.html)).toEqual({ received: { hello: "world" } })
    expect(second.requestId).not.toBe(first.requestId)
    if (!second.requestId) throw new Error("Missing final request ID")
    expect(store.history(10).entries.map((row) => row.id)).toContain(second.requestId)
    const binary = await sendWorkbench(
      api,
      {
        ...draft,
        url: `${target.url}binary`,
        method: "PUT",
        bodyMode: "binary",
        body: "AP+A",
        binaryName: "fixture.bin",
        auth: { ...draft.auth, type: "bearer", token: "owned" },
      },
      new AbortController().signal,
    )
    expect("html" in binary && JSON.parse(binary.html)).toEqual({ body: "AP+A", auth: "Bearer owned" })
    const multipart = await sendWorkbench(
      api,
      {
        ...draft,
        url: `${target.url}multipart`,
        method: "POST",
        bodyMode: "form",
        body: "text=owned",
        fields: {
          ...draft.fields,
          body: [
            {
              enabled: true,
              key: "upload",
              value: "",
              description: "private metadata",
              file: { name: "owned.bin", type: "application/octet-stream", data: "AP+A" },
            },
          ],
        },
      },
      new AbortController().signal,
    )
    expect("html" in multipart && JSON.parse(multipart.html)).toEqual({
      body: "AP+A",
      name: "owned.bin",
      text: "owned",
    })
    expect(calls).toBe(4)
    expect(launches).toBe(0)
  } finally {
    release()
    await app.stop(true)
    target.stop(true)
    store.close()
  }
})
