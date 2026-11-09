import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { planPowWall } from "../src/utils/nativePow"

const ncbiPage = (id: string, bits: number) => `<!doctype html><html><body><script>
const challengeId = "${id}";
const challengeDomain = "pubmed.ncbi.nlm.nih.gov";
const bits = ${bits};
async function submitSolve(nonce) {
  const response = await fetch("/_pow/solve", { method: "POST" });
}
</script></body></html>`

const anubisPage = (algorithm: string, difficulty: number, randomData: string) => `<!doctype html><html><head>
<script id="anubis_version" type="application/json">"v1.25.0"</script>
<script id="anubis_challenge" type="application/json">${JSON.stringify({
  challenge: { id: "chal-1", randomData },
  rules: { algorithm, difficulty },
})}</script>
<script id="anubis_base_prefix" type="application/json">""</script>
<script id="anubis_public_url" type="application/json">""</script>
</head><body></body></html>`

const leadingZeroBits = (hex: string) => {
  let bits = 0
  for (const c of hex) {
    const v = Number.parseInt(c, 16)
    if (v === 0) {
      bits += 4
      continue
    }
    return bits + Math.clz32(v) - 28
  }
  return bits
}

describe("planPowWall", () => {
  test("ignores ordinary pages", () => {
    expect(planPowWall("<html><body>hello</body></html>", "https://example.com/")).toBeUndefined()
  })

  test("solves NCBI identity PoW and builds the /_pow/solve POST", async () => {
    const plan = planPowWall(ncbiPage("abc123", 12), "https://pubmed.ncbi.nlm.nih.gov/33288961/")
    expect(plan?.kind).toBe("ncbi-pow(bits=12)")
    const submit = await plan?.submit()
    expect(submit?.method).toBe("POST")
    expect(submit?.url).toBe("https://pubmed.ncbi.nlm.nih.gov/_pow/solve")
    const payload = JSON.parse(submit?.body ?? "{}")
    expect(payload.challenge_id).toBe("abc123")
    expect(payload.redirect_url).toBe("https://pubmed.ncbi.nlm.nih.gov/33288961/")
    const digest = createHash("sha256").update(`abc123:${payload.nonce}`).digest("hex")
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(12)
  })

  test("solves Anubis fast (leading zero hex digits) and builds pass-challenge", async () => {
    const plan = planPowWall(anubisPage("fast", 3, "deadbeef"), "https://git.example.org/repo?tab=1")
    const submit = await plan?.submit()
    expect(submit?.method).toBe("GET")
    const u = new URL(submit?.url ?? "")
    expect(u.pathname).toBe("/.within.website/x/cmd/anubis/api/pass-challenge")
    expect(u.searchParams.get("id")).toBe("chal-1")
    expect(u.searchParams.get("redir")).toBe("https://git.example.org/repo?tab=1")
    const nonce = u.searchParams.get("nonce")
    const digest = createHash("sha256").update(`deadbeef${nonce}`).digest("hex")
    expect(u.searchParams.get("response")).toBe(digest)
    expect(digest.startsWith("000")).toBe(true)
  })

  test("Anubis preact waits difficulty*80ms and submits sha256(randomData)", async () => {
    const plan = planPowWall(anubisPage("preact", 2, "cafe"), "https://site.example/a?b=c")
    expect(plan?.waitMs).toBeGreaterThanOrEqual(160)
    const u = new URL((await plan?.submit())?.url ?? "")
    expect(u.searchParams.get("result")).toBe(createHash("sha256").update("cafe").digest("hex"))
    expect(u.searchParams.get("redir")).toBe("/a?b=c")
  })

  test("rejects malformed metadata and cross-origin submission prefixes", () => {
    const page = anubisPage("fast", 0, "abcd")
    for (const prefix of ["https://other.example", "//other.example", "/\\other.example", "/?redirect=", {}]) {
      expect(
        planPowWall(page.replace('>""</script>', `>${JSON.stringify(prefix)}</script>`), "https://example.org/"),
      ).toBeUndefined()
    }
    for (const difficulty of [-1, 0.5, 257, "4", {}, null]) {
      expect(
        planPowWall(
          page.replace('"difficulty":0', `"difficulty":${JSON.stringify(difficulty)}`),
          "https://example.org/",
        ),
      ).toBeUndefined()
    }
    expect(planPowWall(anubisPage("unknown", 1, "abcd"), "https://example.org/")).toBeUndefined()
    expect(planPowWall(`<template>${ncbiPage("fixture", 0)}</template>`, "https://example.org/")).toBeUndefined()
  })

  test("a hard solve stays cancellable without blocking the event loop", async () => {
    const plan = planPowWall(ncbiPage("impossible", 256), "https://example.org/")
    const controller = new AbortController()
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 5)
    const cancel = setTimeout(() => controller.abort(), 80)
    const started = performance.now()
    try {
      const active = plan?.submit(1000, controller.signal)
      expect(await planPowWall(ncbiPage("easy", 0), "https://example.org/")?.submit()).toBeUndefined()
      expect(await active).toBeUndefined()
      expect(performance.now() - started).toBeLessThan(2000)
      expect(ticks).toBeGreaterThan(0)
      // Cancellation releases the slot instead of leaving a busy solver behind.
      expect(await planPowWall(ncbiPage("easy", 0), "https://example.org/")?.submit()).toBeDefined()
    } finally {
      clearTimeout(cancel)
      clearInterval(heartbeat)
    }
  })

  test("a solve has a deadline even without a caller signal", async () => {
    const started = performance.now()
    expect(await planPowWall(ncbiPage("impossible", 256), "https://example.org/")?.submit(60)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(2000)
    expect(await planPowWall(ncbiPage("fixture", 257), "https://example.org/")?.submit()).toBeUndefined()
  })
})
