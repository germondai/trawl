import { expect, test } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib"
import { runTier1 } from "../src/tiers/1"
import { friendlyPuzzle, verifyFriendlyProof } from "./fixtures/friendlyCaptcha"
import { installFetchMock } from "./helpers/fetch"

const salt = "owned-fixture?expires=4102444800"
const digest = createHash("sha256").update(`${salt}7`).digest("hex")
const challenge = {
  algorithm: "SHA-256",
  salt,
  challenge: digest,
  signature: createHmac("sha256", "fixture-secret").update(digest).digest("hex"),
  maxnumber: 7,
}
const wall = (widget: string) => `<html><head><title>Human verification</title></head><body>
  <form id="captcha-form" method="post" action="/verify"><input type="hidden" name="csrf" value="fixture-csrf">${widget}</form></body></html>`
const altcha = `<altcha-widget challengejson='${JSON.stringify(challenge)}'></altcha-widget>`
const body = (html: string, headers: Record<string, string> = {}) =>
  new Response(html, { headers: { "content-type": "text/html", ...headers } })

for (const mode of ["altcha-inline", "altcha-url", "friendly-api"] as const) {
  test(`HTTP ${mode} clears a server-verified wall and preserves CSRF/cookies`, async () => {
    const puzzle = friendlyPuzzle()
    let accepted = 0
    const requests: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(`${request.method} ${path}`)
        if (path === "/challenge.json") {
          expect(request.headers.get("cookie")).toContain("pending=fixture")
          return Response.json(challenge)
        }
        if (path === "/puzzle") return Response.json({ data: { puzzle } })
        if (path === "/verify") {
          const form = new URLSearchParams(await request.text())
          if (
            request.method !== "POST" ||
            form.get("csrf") !== "fixture-csrf" ||
            !request.headers.get("cookie")?.includes("pending=fixture")
          )
            return new Response("rejected", { status: 403 })
          let verified: boolean
          if (mode === "friendly-api") verified = verifyFriendlyProof(puzzle, form.get("frc-captcha-solution") ?? "")
          else {
            const payload = JSON.parse(Buffer.from(form.get("altcha") ?? "", "base64").toString())
            const hash = createHash("sha256").update(`${payload.salt}${payload.number}`).digest("hex")
            verified =
              hash === challenge.challenge &&
              payload.signature === createHmac("sha256", "fixture-secret").update(hash).digest("hex")
          }
          if (!verified) return new Response("invalid proof", { status: 403 })
          accepted++
          return new Response(null, {
            status: 303,
            headers: { location: "/content", "set-cookie": "clearance=accepted; Path=/; HttpOnly" },
          })
        }
        if (path === "/content" && request.headers.get("cookie")?.includes("clearance=accepted"))
          return body("<html><body>Protected fixture content</body></html>")
        const widget =
          mode === "altcha-inline"
            ? altcha
            : mode === "altcha-url"
              ? '<altcha-widget challengeurl="/challenge.json"></altcha-widget>'
              : '<div data-sitekey="fixture" data-puzzle-endpoint="/puzzle" class="frc-captcha"><input type="hidden" name="frc-captcha-solution"></div>'
        return body(wall(widget), { "set-cookie": "pending=fixture; Path=/" })
      },
    })
    try {
      const result = await runTier1(server.url.href)
      expect(result.status).toBe("success")
      expect(result.html).toContain("Protected fixture content")
      expect(result.cookies?.some((cookie) => cookie.name === "clearance" && cookie.value === "accepted")).toBe(true)
      expect(accepted).toBe(1)
      expect(requests.filter((request) => request.startsWith("POST"))).toEqual(["POST /verify"])
    } finally {
      server.stop(true)
    }
  })
}

test("HTTP PoW never submits application forms or replays a caller POST", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request.method)
      const html = wall(altcha).replace("Human verification", "Contact us")
      return body(html)
    },
  })
  try {
    await runTier1(server.url.href)
    await runTier1(server.url.href, undefined, "POST", "user=mutation")
    expect(requests).toEqual(["GET", "POST"])
  } finally {
    server.stop(true)
  }
})

test("redirected CAPTCHA submission never forwards the original Authorization or cookies", async () => {
  const seen: { authorization: string | null; cookie: string | null }[] = []
  const target = Bun.serve({
    port: 0,
    fetch(request) {
      seen.push({ authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") })
      if (request.method === "POST")
        return new Response(null, {
          status: 303,
          headers: { location: "/content", "set-cookie": "clearance=ok; Path=/" },
        })
      if (new URL(request.url).pathname === "/content") return body("<html><body>Accepted content</body></html>")
      return body(wall(altcha))
    },
  })
  const origin = Bun.serve({
    port: 0,
    fetch() {
      return Response.redirect(target.url)
    },
  })
  try {
    const result = await runTier1(origin.url.href, { Authorization: "Bearer dummy", Cookie: "private=dummy" })
    expect(result.status).toBe("success")
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen.every((request) => !request.authorization && !request.cookie?.includes("private="))).toBe(true)
  } finally {
    origin.stop(true)
    target.stop(true)
  }
})

test("challenge fetches and form submissions use the configured transport/proxy and outbound validator", async () => {
  const validated: string[] = []
  const fetched: string[] = []
  const restore = installFetchMock(async (url, init) => {
    const target = new URL(String(url))
    expect(init?.proxy).toBe("http://proxy.example:8080")
    fetched.push(target.href)
    expect(validated).toContain(target.href)
    if (target.pathname === "/challenge.json") return Response.json(challenge)
    if (target.pathname === "/verify")
      return new Response(null, {
        status: 303,
        headers: { location: "/content", "set-cookie": "clearance=ok; Path=/" },
      })
    if (target.pathname === "/content") return body("<html><body>Accepted content</body></html>")
    return body(wall('<altcha-widget challengeurl="/challenge.json"></altcha-widget>'))
  })
  try {
    const result = await runTier1(
      "https://target.example/",
      undefined,
      undefined,
      undefined,
      "http://proxy.example:8080",
      async (url) => {
        validated.push(url)
      },
    )
    expect(result.status).toBe("success")
    expect(fetched.map((url) => new URL(url).pathname)).toEqual(["/", "/challenge.json", "/verify", "/content"])
  } finally {
    restore()
  }
})

test("rejects a forbidden challenge URL before fetching it and never submits a proof", async () => {
  const fetched: string[] = []
  const restore = installFetchMock(async (url) => {
    fetched.push(String(url))
    return body(wall('<altcha-widget challengeurl="https://private.example/challenge"></altcha-widget>'))
  })
  try {
    const result = await runTier1(
      "https://target.example/",
      undefined,
      undefined,
      undefined,
      undefined,
      async (url) => {
        if (new URL(url).hostname === "private.example") throw new Error("fixture policy rejection")
      },
    )
    expect(result.status).toBe("needs-js")
    expect(fetched).toEqual(["https://target.example/"])
  } finally {
    restore()
  }
})

test("an uncleared CAPTCHA wall remains unsuccessful even after a 200 POST response", async () => {
  let posts = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.method === "POST") posts++
      return body(wall(altcha), { "set-cookie": "irrelevant=ok; Path=/" })
    },
  })
  try {
    const result = await runTier1(server.url.href)
    expect(result.status).toBe("needs-js")
    expect(posts).toBe(1)
  } finally {
    server.stop(true)
  }
})

test("third-party puzzle requests never receive page credentials or custom headers", async () => {
  let providerSeen = false
  const restore = installFetchMock(async (url, init) => {
    if (new URL(String(url)).hostname === "provider.example") {
      providerSeen = true
      const headers = new Headers(init?.headers as HeadersInit)
      expect(headers.has("authorization")).toBe(false)
      expect(headers.has("cookie")).toBe(false)
      expect(headers.has("x-api-key")).toBe(false)
      expect(headers.get("user-agent")).toBe("fixture-agent")
      return Response.json(challenge)
    }
    return body(wall('<altcha-widget challengeurl="https://provider.example/challenge.json"></altcha-widget>'))
  })
  try {
    await runTier1("https://target.example/", {
      Authorization: "Bearer dummy",
      Cookie: "private=dummy",
      "X-API-Key": "dummy",
      "User-Agent": "fixture-agent",
    })
    expect(providerSeen).toBe(true)
  } finally {
    restore()
  }
})

test("bounds challenge response size and never submits oversized puzzle data", async () => {
  let posts = 0
  const restore = installFetchMock(async (url, init) => {
    if (init?.method === "POST") posts++
    if (new URL(String(url)).pathname === "/challenge.json") return new Response("x".repeat(16_385))
    return body(wall('<altcha-widget challengeurl="/challenge.json"></altcha-widget>'))
  })
  try {
    expect((await runTier1("https://target.example/")).status).toBe("needs-js")
    expect(posts).toBe(0)
  } finally {
    restore()
  }
})

test("a stalled puzzle fetch respects the shared deadline", async () => {
  let posts = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.method === "POST") posts++
      if (new URL(request.url).pathname === "/challenge.json")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"))
            },
          }),
        )
      return body(wall('<altcha-widget challengeurl="/challenge.json"></altcha-widget>'))
    },
  })
  try {
    const start = Date.now()
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
      80,
    )
    expect(result.status).toBe("needs-js")
    expect(Date.now() - start).toBeLessThan(1000)
    expect(posts).toBe(0)
  } finally {
    server.stop(true)
  }
})

for (const [encoding, compress] of Object.entries({
  gzip: gzipSync,
  br: brotliCompressSync,
  deflate: deflateSync,
  zstd: zstdCompressSync,
})) {
  test(`accepts bounded ${encoding} puzzle JSON`, async () => {
    let posts = 0
    const restore = installFetchMock(async (url, init) => {
      if (new URL(String(url)).pathname === "/challenge.json")
        return new Response(compress(Buffer.from(JSON.stringify(challenge))), {
          headers: { "content-encoding": encoding },
        })
      if (init?.method === "POST") {
        posts++
        return new Response(null, { headers: { "set-cookie": "clearance=ok; Path=/" } })
      }
      return body(wall('<altcha-widget challengeurl="/challenge.json"></altcha-widget>'))
    })
    try {
      await runTier1("https://target.example/")
      expect(posts).toBe(1)
    } finally {
      restore()
    }
  })
}

test("bounds decompression of puzzle responses", async () => {
  let posts = 0
  const restore = installFetchMock(async (url, init) => {
    if (init?.method === "POST") posts++
    if (new URL(String(url)).pathname === "/challenge.json")
      return new Response(gzipSync(Buffer.from("x".repeat(1024 * 1024))), { headers: { "content-encoding": "gzip" } })
    return body(wall('<altcha-widget challengeurl="/challenge.json"></altcha-widget>'))
  })
  try {
    expect((await runTier1("https://target.example/")).status).toBe("needs-js")
    expect(posts).toBe(0)
  } finally {
    restore()
  }
})
