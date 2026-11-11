import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { OrchestratorDeps } from "@trawl/tiers"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

test.each(["/scrape", "/v1"])("%s clears a supported access form without acquiring a browser", async (route) => {
  let posts = 0
  let browsers = 0
  const salt = "owned-api-fixture"
  const challenge = {
    algorithm: "SHA-256",
    salt,
    signature: "fixture-signature",
    challenge: createHash("sha256").update(`${salt}1`).digest("hex"),
    maxnumber: 1,
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        posts++
        const form = new URLSearchParams(await request.text())
        const proof = JSON.parse(Buffer.from(form.get("altcha") ?? "", "base64").toString())
        if (
          proof.signature !== challenge.signature ||
          proof.salt !== salt ||
          proof.number !== 1 ||
          form.get("csrf") !== "fixture"
        )
          return new Response("Invalid proof", { status: 403 })
        return new Response(null, {
          status: 303,
          headers: { location: "/content", "set-cookie": "clearance=fixture; Path=/" },
        })
      }
      if (request.headers.get("cookie")?.includes("clearance=fixture"))
        return new Response("<html><body>Owned protected page</body></html>", {
          headers: { "content-type": "text/html" },
        })
      return new Response(
        `<html><head><title>Captcha</title></head><body><form id="altcha-form" method="post" action="/verify">
      <input type="hidden" name="csrf" value="fixture"><altcha-widget challengejson='${JSON.stringify(challenge)}'></altcha-widget>
      </form></body></html>`,
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  const deps: OrchestratorDeps = {
    acquireBrowser: async () => {
      browsers++
      throw new Error("Unexpected browser fallback")
    },
    releaseBrowser() {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }
  const metrics = new MetricsStore()
  const app =
    route === "/scrape"
      ? scrapeRoute(
          () => deps,
          () => true,
          metrics,
        )
      : v1Route({ orchestratorDeps: () => deps, poolReady: () => true, metricsStore: metrics })
  try {
    const response = await app.handle(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: server.url.href,
          ...(route === "/v1" ? { cmd: "request.get" } : { solveEmbeddedCaptchas: false }),
        }),
      }),
    )
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(route === "/v1" ? result.solution.response : result.html).toContain("Owned protected page")
    if (route === "/v1") expect(result.status).toBe("ok")
    else expect(result.tier).toBe(1)
    expect(posts).toBe(1)
    expect(browsers).toBe(0)
    expect(metrics.snapshot().successes).toBe(1)
  } finally {
    server.stop(true)
    metrics.close()
  }
})
