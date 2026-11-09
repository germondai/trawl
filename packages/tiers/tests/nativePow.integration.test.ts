import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { runTier1 } from "../src/tiers/1"
import { ANUBIS_CHALLENGE } from "./fixtures/anubis"

const wall = (bits = 0) => `<!doctype html><html><body><script>
const challengeId = "fixture";
const bits = ${bits};
fetch("/_pow/solve", { method: "POST" });
</script></body></html>`

describe("HTTP proof of work", () => {
  test("follows an accepted Anubis continuation instead of reopening its challenge page", async () => {
    let solves = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.endsWith("/api/pass-challenge")) {
          if (
            url.searchParams.get("challenge") !==
            "ea7ff97b581c1c930d68a1ae4988650df1daec63d250253b26d13be39d5cfff87341d253c91fd559ccbe0440ca2980c77241c2205775f7865927c9d919e67119"
          )
            return new Response(null, { status: 403 })
          solves++
          return new Response(null, {
            status: 303,
            headers: { location: "/content", "set-cookie": "clearance=ok; Path=/" },
          })
        }
        if (url.pathname === "/content" && request.headers.get("cookie")?.includes("clearance=ok")) {
          return new Response("<html><body>Anubis protected content</body></html>", {
            headers: { "content-type": "text/html" },
          })
        }
        return new Response(ANUBIS_CHALLENGE.replaceAll('"difficulty":1', '"difficulty":0'), {
          headers: { "content-type": "text/html" },
        })
      },
    })
    try {
      const result = await runTier1(new URL("/challenge", server.url).href)
      expect(result.html).toContain("Anubis protected content")
      expect(result.effectiveUrl).toBe(new URL("/content", server.url).href)
      expect(solves).toBe(1)
    } finally {
      server.stop(true)
    }
  })
  test("solves a wall and exposes clearance cookies to API callers", async () => {
    let solves = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/_pow/solve") {
          const payload = (await request.json()) as { challenge_id: string; nonce: string }
          if (
            payload.challenge_id !== "fixture" ||
            !createHash("sha256").update(`fixture:${payload.nonce}`).digest("hex").startsWith("000")
          )
            return new Response(null, { status: 403 })
          solves++
          return new Response(null, { headers: { "set-cookie": "clearance=ok; Path=/; HttpOnly" } })
        }
        return request.headers.get("cookie")?.includes("clearance=ok")
          ? new Response("<html><body>protected content</body></html>", { headers: { "content-type": "text/html" } })
          : new Response(wall(12), { headers: { "content-type": "text/html" } })
      },
    })
    try {
      const result = await runTier1(server.url.href)
      expect(result.html).toContain("protected content")
      expect(result.cookies?.some((cookie) => cookie.name === "clearance" && cookie.value === "ok")).toBe(true)
      expect(solves).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test("never resubmits a caller's POST", async () => {
    let posts = 0
    let solves = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/_pow/solve") {
          solves++
          return new Response(null, { headers: { "set-cookie": "clearance=ok; Path=/" } })
        }
        if (request.method === "POST") posts++
        return new Response(wall(), { headers: { "content-type": "text/html" } })
      },
    })
    try {
      await runTier1(server.url.href, undefined, "POST", "mutation")
      expect(posts).toBe(1)
      expect(solves).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test("does not send a cookie beyond its Path", async () => {
    let leaked = false
    let solves = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/_pow/solve") {
          solves++
          leaked = request.headers.get("cookie")?.includes("scoped=secret") ?? false
          return new Response(null, { headers: { "set-cookie": "clearance=ok; Path=/" } })
        }
        return new Response(wall(), {
          headers: { "content-type": "text/html", "set-cookie": "scoped=secret; Path=/private" },
        })
      },
    })
    try {
      await runTier1(new URL("/private/document", server.url).href)
      expect(leaked).toBe(false)
      expect(solves).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test("submits redirected walls at their effective URL and preserves User-Agent", async () => {
    let leaked = false
    let wrongAgent = false
    let solves = 0
    const destination = Bun.serve({
      port: 0,
      fetch(request) {
        leaked ||=
          request.headers.has("authorization") || request.headers.get("cookie")?.includes("private=secret") === true
        wrongAgent ||= request.headers.get("user-agent") !== "fixture-agent"
        if (new URL(request.url).pathname === "/_pow/solve") {
          solves++
          return new Response(null, { headers: { "set-cookie": "clearance=ok; Path=/" } })
        }
        return new Response(
          request.headers.get("cookie")?.includes("clearance=ok")
            ? "<html><body>protected destination</body></html>"
            : wall(),
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const origin = Bun.serve({
      port: 0,
      fetch() {
        return Response.redirect(new URL("/destination", destination.url), 302)
      },
    })
    try {
      const result = await runTier1(origin.url.href, {
        Cookie: "private=secret",
        Authorization: "Bearer dummy",
        "User-Agent": "fixture-agent",
      })
      expect(result.html).toContain("protected destination")
      expect(result.effectiveUrl).toBe(new URL("/destination", destination.url).href)
      expect(solves).toBe(1)
      expect(leaked).toBe(false)
      expect(wrongAgent).toBe(false)
    } finally {
      origin.stop(true)
      destination.stop(true)
    }
  })

  test("validates submission destinations before contacting them", async () => {
    let solves = 0
    let submissionValidated = false
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/_pow/solve") solves++
        return new Response(wall(), { headers: { "content-type": "text/html" } })
      },
    })
    try {
      const result = await runTier1(server.url.href, undefined, undefined, undefined, undefined, async (url) => {
        if (new URL(url).pathname === "/_pow/solve") {
          submissionValidated = true
          throw new Error("fixture policy rejection")
        }
      })
      expect(result.status).toBe("needs-js")
      expect(solves).toBe(0)
      expect(submissionValidated).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("does not report an uncleared wall as successful content", async () => {
    let solves = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/_pow/solve") {
          solves++
          return new Response(null, { headers: { "set-cookie": "irrelevant=ok; Path=/" } })
        }
        return new Response(wall(), { headers: { "content-type": "text/html" } })
      },
    })
    try {
      const result = await runTier1(server.url.href)
      expect(result.status).toBe("needs-js")
      expect(solves).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test("honors the whole HTTP deadline while solving", async () => {
    let solves = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/_pow/solve") solves++
        return new Response(wall(256), { headers: { "content-type": "text/html" } })
      },
    })
    try {
      const started = performance.now()
      const result = await runTier1(
        server.url.href,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        100,
      )
      expect(result.status).toBe("needs-js")
      expect(performance.now() - started).toBeLessThan(2000)
      expect(solves).toBe(0)
    } finally {
      server.stop(true)
    }
  })
})
