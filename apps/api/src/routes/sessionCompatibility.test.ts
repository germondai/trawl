import { expect, test } from "bun:test"
import type { OrchestratorDeps } from "@trawl/tiers"
import { MetricsStore } from "../metrics"
import { v1Route } from "./v1"

test("sessions.create accepts a session command without a scrape URL", async () => {
  const metricsStore = new MetricsStore()
  const app = v1Route({
    poolReady: () => true,
    orchestratorDeps: () =>
      ({
        sessions: { create: async () => ({ id: "login-session" }) },
      }) as unknown as OrchestratorDeps,
    metricsStore,
  })
  try {
    const response = await app.handle(
      new Request("http://localhost/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "sessions.create", session: "login-session" }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: "ok", session: "login-session" })
    expect(metricsStore.snapshot().requests).toBe(0)
  } finally {
    metricsStore.close()
  }
})
