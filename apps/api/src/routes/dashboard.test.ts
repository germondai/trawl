import { describe, expect, test } from "bun:test"
import { MetricsStore } from "../metrics"
import { dashboardRoute } from "./dashboard"

const TOKEN = "this-is-a-long-dashboard-token-for-tests"

describe("local metrics dashboard", () => {
  test("does not register routes until a token is configured", async () => {
    const app = dashboardRoute("", new MetricsStore())
    expect((await app.handle(new Request("http://localhost/dashboard"))).status).toBe(404)
    expect((await app.handle(new Request("http://localhost/dashboard/metrics"))).status).toBe(404)
  })

  test("supports explicit tokenless access for a loopback deployment", async () => {
    const store = new MetricsStore()
    store.record({ source: "native", url: "https://local.example/path", statusCode: 200, durationMs: 10 })
    const app = dashboardRoute("", store, true)
    const shell = await app.handle(new Request("http://localhost/dashboard"))
    const html = await shell.text()
    expect(shell.status).toBe(200)
    expect(html).toContain('data-auth-required="false"')
    expect(html).toContain('<form id="login" hidden>')
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    if (!script) throw new Error("Dashboard script is missing")
    expect(() => new Function(script)).not.toThrow()
    const metrics = await app.handle(new Request("http://localhost/dashboard/metrics"))
    expect(metrics.status).toBe(200)
    expect((await metrics.json()).requests).toBe(1)
    const controller = new AbortController()
    const stream = await app.handle(new Request("http://localhost/dashboard/events", { signal: controller.signal }))
    expect(stream.status).toBe(200)
    controller.abort()
    await stream.body?.cancel()
    store.close()
  })

  test("always shows real history even when a demo query is supplied", async () => {
    const store = new MetricsStore()
    store.record({ source: "native", url: "https://real.example/", statusCode: 200, durationMs: 10 })
    const app = dashboardRoute("", store, true)
    const shell = await app.handle(new Request("http://localhost/dashboard?demo=1"))
    const html = await shell.text()
    expect(html).not.toContain("DEMO DATA")
    expect(html).not.toContain("view sample data")
    const response = await app.handle(new Request("http://localhost/dashboard/metrics?minutes=1440&demo=1"))
    const real = await response.json()
    expect(real.requests).toBe(1)
    expect(real.retainedEvents).toBe(1)
    expect(real.domains[0].domain).toBe("real.example")
    expect(real.waf.observations).toBe(0)
    expect(html).toContain("WAF providers")
    store.close()
  })

  test("serves a dashboard shell without data and requires bearer auth for JSON", async () => {
    const store = new MetricsStore()
    store.record({ source: "mcp", url: "https://sensitive.example/path?secret=1", statusCode: 502, durationMs: 10 })
    const app = dashboardRoute(TOKEN, store)
    const shell = await app.handle(new Request("http://localhost/dashboard"))
    const html = await shell.text()
    expect(shell.status).toBe(200)
    expect(shell.headers.get("content-type")).toContain("text/html")
    expect(html).not.toContain("sensitive.example")
    expect(html).not.toContain(TOKEN)
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    if (!script) throw new Error("Dashboard script is missing")
    expect(() => new Function(script)).not.toThrow()

    const noAuth = await app.handle(new Request("http://localhost/dashboard/metrics"))
    const wrongAuth = await app.handle(
      new Request("http://localhost/dashboard/metrics", { headers: { authorization: "Bearer wrong" } }),
    )
    expect(noAuth.status).toBe(401)
    expect(wrongAuth.status).toBe(401)
    expect(await wrongAuth.text()).not.toContain("sensitive.example")
    const noStreamAuth = await app.handle(new Request("http://localhost/dashboard/events"))
    expect(noStreamAuth.status).toBe(401)

    const authorized = await app.handle(
      new Request("http://localhost/dashboard/metrics", { headers: { authorization: `Bearer ${TOKEN}` } }),
    )
    expect(authorized.status).toBe(200)
    expect(authorized.headers.get("cache-control")).toBe("no-store")
    const body = await authorized.json()
    expect(body.domains[0].domain).toBe("sensitive.example")
    expect(JSON.stringify(body)).not.toContain("secret=1")
    expect(body.recentEvents[0].domain).toBe("sensitive.example")
    const day = await app.handle(
      new Request("http://localhost/dashboard/metrics?minutes=1440", { headers: { authorization: `Bearer ${TOKEN}` } }),
    )
    expect((await day.json()).rangeMinutes).toBe(1440)
  })

  test("streams an update after a completed request", async () => {
    const store = new MetricsStore()
    const controller = new AbortController()
    const app = dashboardRoute(TOKEN, store)
    const response = await app.handle(
      new Request("http://localhost/dashboard/events", {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("connected")
    store.record({ source: "native", url: "https://events.example/", statusCode: 200, durationMs: 2 })
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("event: update")
    controller.abort()
    await reader?.cancel()
    store.close()
  })
})
