import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cookiePairs, mergeCookieHeader, planPowWall } from "../src/utils/nativePow"

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

  test("solves NCBI identity PoW and builds the /_pow/solve POST", () => {
    const plan = planPowWall(ncbiPage("abc123", 12), "https://pubmed.ncbi.nlm.nih.gov/33288961/")
    expect(plan?.kind).toBe("ncbi-pow(bits=12)")
    const submit = plan?.submit()
    expect(submit?.method).toBe("POST")
    expect(submit?.url).toBe("https://pubmed.ncbi.nlm.nih.gov/_pow/solve")
    const payload = JSON.parse(submit?.body ?? "{}")
    expect(payload.challenge_id).toBe("abc123")
    expect(payload.redirect_url).toBe("https://pubmed.ncbi.nlm.nih.gov/33288961/")
    const digest = createHash("sha256").update(`abc123:${payload.nonce}`).digest("hex")
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(12)
  })

  test("solves Anubis fast (leading zero hex digits) and builds pass-challenge", () => {
    const plan = planPowWall(anubisPage("fast", 3, "deadbeef"), "https://git.example.org/repo?tab=1")
    const submit = plan?.submit()
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

  test("Anubis preact waits difficulty*80ms and submits sha256(randomData)", () => {
    const plan = planPowWall(anubisPage("preact", 2, "cafe"), "https://site.example/a?b=c")
    expect(plan?.waitMs).toBeGreaterThanOrEqual(160)
    const u = new URL(plan?.submit()?.url ?? "")
    expect(u.searchParams.get("result")).toBe(createHash("sha256").update("cafe").digest("hex"))
    expect(u.searchParams.get("redir")).toBe("/a?b=c")
  })
})

describe("cookie helpers", () => {
  test("cookiePairs keeps name=value only", () => {
    expect(cookiePairs("a=1; Path=/; HttpOnly\nb=2; Secure")).toEqual(["a=1", "b=2"])
  })

  test("mergeCookieHeader overrides by name", () => {
    expect(mergeCookieHeader("a=1; c=3", ["a=2", "b=4"])).toBe("a=2; c=3; b=4")
  })
})
