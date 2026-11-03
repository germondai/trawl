import { expect, test } from "bun:test"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import type net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { OrchestratorDeps } from "@trawl/tiers"
import { MetricsStore } from "./metrics"
import { serveViaScrape, shutdownMitmProxy, startMitmProxy } from "./proxy/server"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

for (const entry of ["native", "flaresolverr", "proxy"] as const) {
  test.each([
    { mode: "deployment default", configured: 60, explicit: undefined, success: false },
    { mode: "longer explicit timeout", configured: 60, explicit: 1000, success: true },
    { mode: "shorter explicit timeout", configured: 1000, explicit: 60, success: false },
  ])(`${entry} honors $mode`, async ({ configured, explicit, success }) => {
    const origin = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(200)
        return new Response(`<html><body><article>${"Owned content. ".repeat(40)}</article></body></html>`, {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const metrics = new MetricsStore()
    const stream = new PassThrough()
    const deps: OrchestratorDeps = {
      defaultMaxTimeout: configured,
      acquireBrowser: async () => {
        throw new Error("Timeout tests must not acquire a browser")
      },
      releaseBrowser() {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    try {
      let status: number
      let body: string
      if (entry === "proxy") {
        const chunks: Buffer[] = []
        stream.on("data", (chunk: Buffer) => chunks.push(chunk))
        await serveViaScrape(stream as unknown as net.Socket, origin.url.href, "GET", {}, undefined, {
          port: 0,
          host: "127.0.0.1",
          caDir: "",
          maxTier: 1,
          maxTimeout: explicit,
          deps,
        })
        body = Buffer.concat(chunks).toString()
        status = Number(body.match(/^HTTP\/1\.1 (\d+)/)?.[1])
      } else {
        const app =
          entry === "native"
            ? scrapeRoute(
                () => deps,
                () => true,
                metrics,
              )
            : v1Route({ poolReady: () => true, orchestratorDeps: () => deps, metricsStore: metrics })
        const response = await app.handle(
          new Request(`http://localhost/${entry === "native" ? "scrape" : "v1"}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cmd: "request.get", url: origin.url.href, maxTimeout: explicit }),
          }),
        )
        status = response.status
        body = await response.text()
        expect(metrics.snapshot().requests).toBe(1)
      }
      expect(status).toBe(success ? 200 : entry === "proxy" ? 502 : 500)
      expect(body).toContain(success ? "Owned content." : "Scrape deadline exceeded")
      if (entry === "proxy" && !success) expect(body.toLowerCase()).toContain("proxy-status: trawl; error=")
    } finally {
      origin.stop(true)
      stream.destroy()
      metrics.close()
    }
  })
}

for (const entry of ["native", "flaresolverr"] as const) {
  test(`${entry} rejects a nested proxy timeout and preserves origin errors`, async () => {
    const origin = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname === "/error") return new Response("Origin unavailable", { status: 502 })
        await Bun.sleep(300)
        return new Response("Late origin response")
      },
    })
    const metrics = new MetricsStore()
    const deps: OrchestratorDeps = {
      defaultMaxTimeout: 60,
      acquireBrowser: async () => {
        throw new Error("Proxy failures must not acquire a browser or retry directly")
      },
      releaseBrowser() {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const caDir = mkdtempSync(join(tmpdir(), "trawl-proxy-timeout-"))
    const proxy = startMitmProxy({ port: 0, host: "127.0.0.1", caDir, alwaysScrape: true, maxTier: 1, deps })
    try {
      if (!proxy.server.listening) await once(proxy.server, "listening")
      const address = proxy.server.address()
      if (!address || typeof address === "string") throw new Error("Proxy has no listening port")
      const app =
        entry === "native"
          ? scrapeRoute(
              () => deps,
              () => true,
              metrics,
            )
          : v1Route({ poolReady: () => true, orchestratorDeps: () => deps, metricsStore: metrics })
      for (const path of ["/error", "/slow"]) {
        const response = await app.handle(
          new Request(`http://localhost/${entry === "native" ? "scrape" : "v1"}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              cmd: "request.get",
              url: new URL(path, origin.url).href,
              maxTimeout: 2000,
              proxy:
                entry === "native" ? `http://127.0.0.1:${address.port}` : { url: `http://127.0.0.1:${address.port}` },
            }),
          }),
        )
        const body = await response.json()
        if (path === "/error") {
          expect(response.status).toBe(200)
          expect(entry === "native" ? body.statusCode : body.solution.status).toBe(502)
          expect(entry === "native" ? body.html : body.solution.response).toBe("Origin unavailable")
        } else {
          expect(response.status).toBe(500)
          expect(entry === "native" ? body.error : body.message).toBe("proxy-connection-failed")
          if (entry === "flaresolverr") expect(body).toMatchObject({ status: "error", solution: { status: 0 } })
        }
      }
      expect(metrics.snapshot().failures).toBe(2)
    } finally {
      origin.stop(true)
      await shutdownMitmProxy(proxy, 100)
      metrics.close()
      rmSync(caDir, { recursive: true, force: true })
    }
  })
}
